import { test } from 'node:test';
import { cpuTimed } from './helpers/timing.mjs';
import assert from 'node:assert/strict';
import { splitArgs, simpleCommands, commandName, allRedirects, scriptFileOf } from '../pipeline/hooks/lib/shell-parse.mjs';

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
  ['case branch', 'case $x in main) git push origin main ;; esac', ['case $x in', 'git push origin main'], 'exact'], // (the pattern `main)` is no command: guard-a2-shell-s6.test.mjs
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
    const { r: cmds, ms } = cpuTimed(() => simpleCommands(s));
    assert.ok(Array.isArray(cmds));
    assert.ok(ms < 5000, `finished in reasonable time (${Math.round(ms)} ms of CPU)`);
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
  const alphabet = ['a', 'git ', 'push', ' ', ' ', '"', "'", '`', '$(', ')', '(', '{', '}', ';', '&&', '||', '|', '&', '\n', '\\', '<<EOF', '<<-', '<', '>', '2>&1', '#', '$', '=', 'bash -c ', 'env ', 'sudo ', '$((', '<(', '>(', '{a,b}', ',', '$[', ']', '<<<', '>&2', '|&', '.\\g', 'tmux ', 'su -c ', 'watch ', 'flock ', 'eval ', 'source ', 'bash -s', 'Start-Process '];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 6000; k++) {
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
  assert.deepEqual(argvs('echo ${HOME}/x {a} {} a{b}c'), ['echo ${HOME}/x {a} {} a{b}c']);
});

// ==== review round 2: hiding spots confirmed against real bash =====================================

const has = (s, cmd, o) => argvs(s, o).includes(cmd);
const hasArgv = (s, argv) => simpleCommands(s).some((c) => c.argv.length === argv.length && c.argv.every((w, i) => w === argv[i]));
const PUSH = ['git', 'push', 'origin', 'main'];
const find = (s, cmd) => simpleCommands(s).find((c) => c.argv.join(' ') === cmd);

// 1. shells that read their script from stdin
const STDIN_SHELLS = [
  ['bash - with heredoc', "bash - <<'EOF'\ngit push origin main\nEOF"],
  ['bash -s with heredoc', 'bash -s <<EOF\ngit push origin main\nEOF'],
  ['bash -s with positional args', 'bash -s -- a b <<< "git push origin main"'],
  ['bash -ls', 'bash -ls <<< "git push origin main"'],
  ['sh /dev/stdin', 'sh /dev/stdin <<EOF\ngit push origin main\nEOF'],
  ['bash /dev/fd/0', 'bash /dev/fd/0 <<< "git push origin main"'],
  ['source /dev/stdin', 'source /dev/stdin <<< "git push origin main"'],
  ['dot /dev/fd/0', '. /dev/fd/0 <<EOF\ngit push origin main\nEOF'],
  ['group piped into bash', '{ echo "git push origin main"; } | bash'],
  ['subshell piped into sh', '(echo "git push origin main") | sh'],
  ['two-command subshell piped into bash', '(echo hi; echo "git push origin main") | bash'],
  ['printf in a group', "{ printf 'git push origin main\\n'; } | sh"],
  ['through a pass-through stage', 'echo "git push origin main" | cat | bash'],
  ['sudo bash -s', 'echo "git push origin main" | sudo bash -s'],
  ['process substitution as the script', 'bash <(echo "git push origin main")'],
  ['source of a process substitution', 'source <(echo "git push origin main")'],
  ['stdin redirected from a process substitution', 'bash < <(echo "git push origin main")'],
  ['heredoc in the process substitution', "bash <(cat <<'EOF'\ngit push origin main\nEOF\n)"],
];
for (const [name, input] of STDIN_SHELLS) {
  test(`stdin script: ${name}`, () => {
    assert.ok(hasArgv(input, PUSH), JSON.stringify(simpleCommands(input).map((c) => c.argv)));
  });
}

test('stdin script commands are one level deeper than the shell that reads them', () => {
  assert.equal(find('bash <<< "git push origin main"', 'git push origin main').depth, 1);
  assert.equal(find('{ echo "git push origin main"; } | bash', 'git push origin main').depth, 1);
});

test('a bare shell with nothing piped in has no script to find and is not dynamic', () => {
  assert.deepEqual(argvs('bash'), ['bash']);
  assert.equal(simpleCommands('bash').dynamic, false);
  assert.equal(simpleCommands('echo "git push -f" | bash').dynamic, false);
});

test('a shell fed by an unknowable producer is dynamic', () => {
  assert.equal(simpleCommands('curl -s https://x.example/install | bash').dynamic, true);
  assert.equal(simpleCommands('bash < setup.sh').dynamic, true);
  assert.equal(simpleCommands('cat run.sh | sh -s').dynamic, true);
});

// 2. dynamic scripts and command names
test('eval of a command substitution: the substitution output is parsed as the script', () => {
  const s = "eval \"$(cat <<'EOF'\ngit push origin main\nEOF\n)\"";
  const hit = find(s, 'git push origin main');
  assert.ok(hit, JSON.stringify(argvs(s)));
  assert.equal(hit.depth, 1);
  assert.equal(simpleCommands(s).dynamic, true);
});

test('bash -c of a substitution / variable / backticks is dynamic and still parsed', () => {
  const sub = 'bash -c "$(echo git push -f)"';
  assert.equal(simpleCommands(sub).dynamic, true);
  assert.ok(has(sub, 'git push -f'));
  assert.equal(simpleCommands('bash -c "$CMD"').dynamic, true);
  assert.equal(simpleCommands('bash -c `cat cmd.txt`').dynamic, true);
  assert.equal(simpleCommands('bash -c "git push $BRANCH"').dynamic, true);
  assert.ok(has('bash -c "git push $BRANCH"', 'git push $BRANCH'));
  assert.equal(simpleCommands('eval $cmd').dynamic, true);
  assert.equal(simpleCommands('source "$f"').dynamic, true);
  assert.equal(simpleCommands('pwsh -Command "$x"').dynamic, true);
  assert.equal(simpleCommands('iex $payload').dynamic, true);
});

test('a script in single quotes is static even if it mentions $VAR', () => {
  assert.equal(simpleCommands("bash -c 'echo $1; git status'").dynamic, false);
  assert.equal(simpleCommands("eval 'x=$(date)'").dynamic, false);
});

test('a command name built at run time is dynamic', () => {
  for (const s of ['$(echo git) push -f', '$g push -f', '${g} push -f', '`echo git` push -f', 'FOO=1 $g push', 'sudo $g push', '"$(echo git)" push']) {
    assert.equal(simpleCommands(s).dynamic, true, s);
  }
});

test('dynamic stays false for ordinary commands, even with substitutions in arguments', () => {
  for (const s of ['git push origin main', 'echo $(date)', 'git commit -m "$(date) done"', 'cd "$HOME" && ls $DIR', 'git push origin $BRANCH', "grep -r 'git push' docs/", 'bash -c "echo hi"']) {
    assert.equal(simpleCommands(s).dynamic, false, s);
  }
});

test('dynamic is a non-enumerable property like truncated', () => {
  const cmds = simpleCommands('git status');
  assert.deepEqual(Object.keys(cmds), ['0']);
  assert.equal(cmds.dynamic, false);
});

test('gh pr create with a heredoc body mentioning an approval label: no command is invented from the body', () => {
  const s = "gh pr create --title t --body \"$(cat <<'EOF'\nPlease run gh pr edit 1 --add-label human-approved and git push origin main\nEOF\n)\"";
  const cmds = simpleCommands(s);
  assert.deepEqual(sorted(cmds.map((c) => c.argv[0])), ['cat', 'gh']);
  assert.equal(cmds.dynamic, false);
  assert.equal(cmds.truncated, false);
});

// 3. brace expansion
const BRACES = [
  ['alternatives become extra words of ONE command (bash: git push status origin main)', 'git {push,status} origin main', ['git push status origin main']],
  ['empty alternative', 'git push origin ma{in,}', ['git push origin main ma']],
  ['command name and flags from braces', '{git,push,-f}', ['git push -f']],
  ['two groups multiply left to right', 'echo {a,b}{1,2}', ['echo a1 a2 b1 b2']],
  ['nested', 'echo {a,{b,c}}', ['echo a b c']],
  ['prefix and suffix', 'echo pre{x,y}post', ['echo prexpost preypost']],
  ['single alternative is not a brace expression', 'echo a{b}c {x}', ['echo a{b}c {x}']],
  ['double-quoted braces', 'echo "{a,b}"', ['echo {a,b}']],
  ['single-quoted braces', "echo '{a,b}'", ['echo {a,b}']],
  ['escaped opening brace', 'echo \\{a,b}', ['echo {a,b}']],
  ['quoted part next to a brace group', 'echo "x"{a,b}', ['echo xa xb']],
  ['parameter expansion braces are not brace expansion', 'echo ${HOME}{a,b}', ['echo ${HOME}a ${HOME}b']],
  ['${x:-a,b} keeps its comma', 'echo ${x:-a,b}', ['echo ${x:-a,b}']],
  ['export arguments expand', 'export Q={a,b}', ['export Q=a Q=b']],
  ['expansion inside a pipeline stage', 'echo {a,b} | tee f{1,2}', ['echo a b', 'tee f1 f2']],
];
for (const [name, input, expected] of BRACES) {
  test(`brace expansion: ${name}`, () => {
    assert.deepEqual(argvs(input), expected);
  });
}

test('brace expansion: leading assignment words are not expanded', () => {
  const [c] = simpleCommands('FOO={a,b} git push');
  assert.deepEqual(c.argv, ['git', 'push']);
  assert.deepEqual(c.env, { FOO: '{a,b}' });
});

test('brace expansion: a wrapper sees the expanded words', () => {
  assert.deepEqual(argvs('sudo {git,push}'), ['git push']);
  assert.ok(has('bash -c "git push"; {sh,-c,"git push -f"}', 'git push -f'));
});

test('brace expansion cap: 64 results per word, beyond that truncated is set', () => {
  const ok = simpleCommands('echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}');
  assert.equal(ok[0].argv.length, 1 + 64);
  assert.equal(ok.truncated, false);
  const over = simpleCommands('echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}');
  assert.equal(over[0].argv.length, 1 + 64);
  assert.equal(over.truncated, true);
  const huge = simpleCommands('echo ' + '{a,b,c,d,e,f,g,h}'.repeat(40));
  assert.ok(huge[0].argv.length <= 1 + 64);
  assert.equal(huge.truncated, true);
});

// 4. more launchers
const LAUNCHERS = [
  ['watch', 'watch -n 5 git push origin main'],
  ['watch with a quoted command string', "watch -d 'git push origin main'"],
  ['caffeinate', 'caffeinate -i git push origin main'],
  ['caffeinate -t', 'caffeinate -t 60 git push origin main'],
  ['flock', 'flock /tmp/lock git push origin main'],
  ['flock with options', 'flock -n -w 5 /tmp/lock git push origin main'],
  ['flock -c after the file', "flock /tmp/lock -c 'git push origin main'"],
  ['flock -c before the file', "flock -c 'git push origin main' /tmp/lock"],
  ['arch -x86_64', 'arch -x86_64 git push origin main'],
  ['arch -arch', 'arch -arch arm64 git push origin main'],
  ['su -c', "su -c 'git push origin main' root"],
  ['su - user -c', 'su - bob -c "git push origin main"'],
  ['su user -c', "su root -c 'git push origin main'"],
  ['su -lc', "su -lc 'git push origin main'"],
  ['busybox sh -c', "busybox sh -c 'git push origin main'"],
  ['busybox applet', 'busybox git push origin main'],
  ['sudo -s', "sudo -s 'git push origin main'"],
  ['sudo -i', "sudo -i 'git push origin main'"],
  ['sudo -u user -s', "sudo -u bob -s 'git push origin main'"],
  ['ash -c', "ash -c 'git push origin main'"],
  ['ksh93 -c', "ksh93 -c 'git push origin main'"],
  ['mksh -c', "mksh -c 'git push origin main'"],
  ['tmux new-session', "tmux new-session -d -s work 'git push origin main'"],
  ['tmux split-window', 'tmux split-window -h "git push origin main"'],
  ['tmux run-shell', "tmux run-shell -b 'git push origin main'"],
  ['tmux send-keys', "tmux send-keys -t work 'git push origin main' Enter"],
  ['tmux with global options', "tmux -L sock new-session -d 'git push origin main'"],
  ['iex', 'iex "git push origin main"'],
  ['Invoke-Expression', "Invoke-Expression 'git push origin main'"],
  ['Start-Process with string args', "Start-Process -FilePath git -ArgumentList 'push origin main'"],
  ['Start-Process positional', 'Start-Process git -ArgumentList "push origin main" -NoNewWindow'],
  ['Start-Process with list args', 'Start-Process git -ArgumentList push,origin,main'],
  ['cmd /c start', 'cmd /c start git push origin main'],
  ['cmd /c start with title and flags', 'cmd /c start /b "" git push origin main'],
];
for (const [name, input] of LAUNCHERS) {
  test(`launcher: ${name}`, () => {
    assert.ok(hasArgv(input, PUSH), JSON.stringify(simpleCommands(input).map((c) => c.argv)));
  });
}

test('launchers that only wrap return the unwrapped command', () => {
  assert.deepEqual(argvs('caffeinate -i git push -f'), ['git push -f']);
  assert.deepEqual(argvs('arch -x86_64 git push -f'), ['git push -f']);
  assert.deepEqual(argvs('flock /tmp/l git push -f'), ['git push -f']);
  assert.deepEqual(argvs('busybox git push -f'), ['git push -f']);
});

test('launchers that are not about running commands are left alone', () => {
  assert.deepEqual(argvs('tmux list-sessions'), ['tmux list-sessions']);
  assert.deepEqual(argvs('su'), ['su']);
  assert.deepEqual(argvs('su root'), ['su root']);
  assert.deepEqual(argvs('sudo -l'), ['sudo -l']);
  assert.deepEqual(argvs('flock /tmp/l'), ['flock /tmp/l']);
});

// 5. Windows paths
test('Windows paths: argv[0] keeps its backslashes and its command name is git', () => {
  for (const s of ['C:\\Git\\bin\\git.exe push origin main', '.\\git.exe push origin main', '..\\tools\\GIT.EXE push origin main', '"C:\\Program Files\\Git\\bin\\git.exe" push origin main', "'C:\\Program Files\\Git\\cmd\\git.exe' push origin main", '\\\\server\\share\\git.exe push origin main']) {
    const [c] = simpleCommands(s);
    assert.equal(commandName(c.argv[0]), 'git', `${s} -> ${JSON.stringify(c.argv)}`);
    assert.deepEqual(c.argv.slice(1), ['push', 'origin', 'main'], s);
  }
  assert.equal(simpleCommands('C:\\Git\\bin\\git.exe push')[0].argv[0], 'C:\\Git\\bin\\git.exe');
});

test('Windows paths: wrappers and interpreters are recognised by path too', () => {
  assert.ok(has('C:\\Windows\\System32\\cmd.exe /c "git push origin main"', 'git push origin main'));
  assert.ok(has('C:\\PowerShell\\7\\pwsh.exe -Command "git push origin main"', 'git push origin main'));
  assert.ok(has('C:\\msys\\usr\\bin\\env.exe FOO=1 git push origin main', 'git push origin main'));
  assert.ok(has('"C:\\Program Files\\Git\\bin\\bash.exe" -c "git push origin main"', 'git push origin main'));
});

test('POSIX backslash escapes are unchanged for everything that is not a path', () => {
  assert.deepEqual(argvs('\\git push'), ['git push']);
  assert.deepEqual(argvs('echo a\\ b c\\d'), ['echo a b cd']);
  assert.deepEqual(argvs('echo C:\\Users\\me'), ['echo C:Usersme']);
  assert.deepEqual(argvs('my\\ cmd arg'), ['my cmd arg']);
});

test('commandName normalises to a lowercase basename without the extension', () => {
  assert.equal(commandName('git'), 'git');
  assert.equal(commandName('/usr/bin/git'), 'git');
  assert.equal(commandName('C:\\Git\\bin\\Git.EXE'), 'git');
  assert.equal(commandName('.\\git.exe'), 'git');
  assert.equal(commandName('\\git'), 'git');
  assert.equal(commandName('./node_modules/.bin/tsc.cmd'), 'tsc');
  assert.equal(commandName(''), '');
  assert.equal(commandName(undefined), '');
  assert.equal(commandName(42), '42');
});

// 6. $[ ] arithmetic is not a heredoc
test('$[...] arithmetic does not open a heredoc', () => {
  const cmds = simpleCommands('echo $[1<<3]\ngit push -f');
  assert.deepEqual(cmds.map((c) => [c.argv.join(' '), c.depth]), [['echo $[1<<3]', 0], ['git push -f', 0]]);
  assert.equal(cmds.truncated, false);
  assert.ok(has('echo $[ $(git push -f) + 1 ]', 'git push -f'));
  assert.deepEqual(argvs("echo '$[1<<3]'\ngit status"), ['echo $[1<<3]', 'git status']);
});

// 7. pins
test('truncated: MAX_NEST (in-place nesting), MAX_WORK (input size) and the exception path', () => {
  assert.equal(simpleCommands('('.repeat(250) + 'git push').truncated, true);
  const ok = simpleCommands('('.repeat(150) + 'git push' + ')'.repeat(150));
  assert.equal(ok.truncated, false);
  assert.ok(ok.some((c) => c.argv.join(' ') === 'git push'));
  assert.equal(simpleCommands('x'.repeat(8_100_000)).truncated, true);
  const boom = simpleCommands({ toString() { throw new Error('boom'); } });
  assert.deepEqual([...boom], []);
  assert.equal(boom.truncated, true);
});

test('a & git push: background operator separates commands', () => {
  assert.deepEqual(argvs('a & git push'), ['a', 'git push']);
  assert.deepEqual(argvs('sleep 1 & git push -f &'), ['sleep 1', 'git push -f']);
});

test('backticks inside double quotes run', () => {
  assert.ok(has('echo "x `git push -f` y"', 'git push -f'));
  assert.ok(!has('echo "x \\`git push -f\\` y"', 'git push -f'));
  assert.ok(!has("echo 'x `git push -f` y'", 'git push -f'));
});

test('CRLF inside double quotes: continuation lines join, plain CRLF stays in the string', () => {
  assert.deepEqual(simpleCommands('echo "a\\\r\nb"; git push -f')[0].argv, ['echo', 'ab']);
  assert.deepEqual(simpleCommands('git commit -m "line1\r\nline2; git push -f"').map((c) => c.argv.length), [4]);
  assert.deepEqual(argvs('git status\r\ngit push -f\r\n'), ['git status', 'git push -f']);
  assert.ok(has('echo "$(git push -f\r\n)"', 'git push -f'));
});

const WRAP_CASES = [
  ['builtin', 'builtin cd /tmp', 'cd /tmp'],
  ['setsid', 'setsid git push -f', 'git push -f'],
  ['setsid -f', 'setsid -f git push -f', 'git push -f'],
  ['ionice', 'ionice -c 3 -n 7 git push -f', 'git push -f'],
  ['ionice -t', 'ionice -t git push -f', 'git push -f'],
  ['stdbuf', 'stdbuf -oL -e0 git push -f', 'git push -f'],
  ['stdbuf separate values', 'stdbuf -o L git push -f', 'git push -f'],
  ['doas', 'doas git push -f', 'git push -f'],
  ['doas -u', 'doas -u bob git push -f', 'git push -f'],
];
for (const [name, input, expected] of WRAP_CASES) {
  test(`wrapper: ${name}`, () => assert.deepEqual(argvs(input), [expected]));
}

test('dash, ksh, fish -c recurse like bash', () => {
  for (const sh of ['dash', 'ksh', 'fish', 'zsh', 'sh', 'bash']) {
    assert.ok(has(`${sh} -c "git push origin main"`, 'git push origin main'), sh);
  }
});

test('shell keywords else / elif / until / coproc do not hide the command after them', () => {
  assert.ok(has('if a; then b; else git push -f; fi', 'git push -f'));
  assert.ok(has('if a; then b; elif git push -f; then c; fi', 'git push -f'));
  assert.ok(has('until git push -f; do sleep 1; done', 'git push -f'));
  assert.ok(has('coproc git push -f', 'git push -f'));
  assert.ok(has('if a; then\n  git push -f\nfi', 'git push -f'));
});

test('false positives stay at zero for text that merely mentions commands', () => {
  const quiet = [
    ['git commit -m "docs: explain git push origin main and gh pr edit 1 --add-label human-approved"', ['git commit -m docs: explain git push origin main and gh pr edit 1 --add-label human-approved']],
    ['grep -rn "git push -f" docs/', ['grep -rn git push -f docs/']],
    ['echo "run: git push origin main"', ['echo run: git push origin main']],
    ["echo 'bash -c \"git push -f\"'", ['echo bash -c "git push -f"']],
    ["cat <<'EOF'\ngit push origin main\n$(git push -f)\nEOF", ['cat']],
    ['printf "%s\\n" "git push -f"', ['printf %s\\n git push -f']],
  ];
  for (const [input, expected] of quiet) assert.deepEqual(argvs(input), expected, input);
});

// ==== redirects are exposed on every command ======================================================

const redirs = (s) => simpleCommands(s).map((c) => c.redirects);
const R = (op, target, fd = null) => ({ op, target, fd });

test('redirects: every command has an array, empty when there is none', () => {
  for (const c of simpleCommands('git status; echo a | cat; FOO=1; bash -c "ls"')) assert.deepEqual(c.redirects, []);
});

test('redirects: cd ~ && echo x > .claude/settings.json records the write on the second command', () => {
  const [cd, echo] = simpleCommands('cd ~ && echo x > .claude/settings.json');
  assert.deepEqual(cd.redirects, []);
  assert.deepEqual(cd.argv, ['cd', '~']);
  assert.deepEqual(echo.argv, ['echo', 'x']);
  assert.deepEqual(echo.redirects, [R('>', '.claude/settings.json')]);
});

test('redirects: cat > a <<EOF records the file and the heredoc (target null)', () => {
  const [cat] = simpleCommands('cat > a <<EOF\nbody\nEOF');
  assert.deepEqual(cat.argv, ['cat']);
  assert.deepEqual(cat.redirects, [R('>', 'a'), R('<<', null)]);
  assert.deepEqual(simpleCommands('cat <<EOF > a\nbody\nEOF')[0].redirects, [R('<<', null), R('>', 'a')]);
  assert.deepEqual(simpleCommands("cat <<-'EOF' > a\n\tbody\n\tEOF")[0].redirects, [R('<<', null), R('>', 'a')]);
});

test('redirects: cmd 2>&1 | tee x keeps the fd duplication as &1 and tee keeps its argument', () => {
  const [cmd, tee] = simpleCommands('cmd 2>&1 | tee x');
  assert.deepEqual(cmd.redirects, [R('>&', '&1', 2)]);
  assert.deepEqual(tee.argv, ['tee', 'x']);
  assert.deepEqual(tee.redirects, []);
});

const REDIRECT_FORMS = [
  ['>', 'echo x > out', [R('>', 'out')]],
  ['>>', 'echo x >> out', [R('>>', 'out')]],
  ['>|', 'echo x >| out', [R('>|', 'out')]],
  ['&>', 'echo x &> out', [R('&>', 'out')]],
  ['&>>', 'echo x &>> out', [R('&>>', 'out')]],
  ['2>', 'echo x 2> err', [R('>', 'err', 2)]],
  ['2>>', 'echo x 2>>err', [R('>>', 'err', 2)]],
  ['3>', 'exec 3> fdfile', [R('>', 'fdfile', 3)]],
  ['<', 'wc -l < in.txt', [R('<', 'in.txt')]],
  ['0<', 'wc -l 0< in.txt', [R('<', 'in.txt', 0)]],
  ['<>', 'cat <> rw', [R('<>', 'rw')]],
  ['<<<', 'cat <<< "hello world"', [R('<<<', 'hello world')]],
  ['<<', 'cat << EOF\nx\nEOF', [R('<<', null)]],
  ['<<-', 'cat <<-EOF\n\tx\n\tEOF', [R('<<', null)]],
  ['>&2', 'echo x >&2', [R('>&', '&2')]],
  ['2>&1', 'echo x 2>&1', [R('>&', '&1', 2)]],
  ['>&-', 'echo x >&-', [R('>&', '&-')]],
  ['<&0', 'cat <&0', [R('<&', '&0')]],
  ['>&file writes a file (both streams)', 'echo x >& both.log', [R('>&', 'both.log')]],
  ['attached target', 'echo x>out', [R('>', 'out')]],
  ['quoted target loses its quotes', 'echo x > "my file.txt"', [R('>', 'my file.txt')]],
  ['single-quoted target', "echo x >> '/tmp/a b'", [R('>>', '/tmp/a b')]],
  ['target with a substitution stays raw', 'echo x > $(mktemp)', [R('>', '$(mktemp)')]],
  ['target with a variable stays raw', 'echo x > "$HOME/.claude/settings.json"', [R('>', '$HOME/.claude/settings.json')]],
  ['several, in order', 'cmd 2>/dev/null >out <in', [R('>', '/dev/null', 2), R('>', 'out'), R('<', 'in')]],
  ['redirect before the command word', '>out echo x', [R('>', 'out')]],
  ['redirect in the middle', 'echo a >out b', [R('>', 'out')]],
  ['process substitution target', 'echo x > >(tee f)', [R('>', '>(tee f)')]],
];
for (const [name, input, expected] of REDIRECT_FORMS) {
  test(`redirects: ${name}`, () => {
    const cmds = simpleCommands(input);
    assert.deepEqual(cmds[cmds.length - 1].redirects, expected, JSON.stringify(cmds));
  });
}

test('redirects: a digit that is a real argument is not an fd', () => {
  const [c] = simpleCommands('echo 2 > f');
  assert.deepEqual(c.argv, ['echo', '2']);
  assert.deepEqual(c.redirects, [R('>', 'f')]);
});

test('redirects: a redirect with no command still comes back (> file truncates it)', () => {
  const cmds = simpleCommands('> .claude/settings.json');
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0].argv, []);
  assert.deepEqual(cmds[0].redirects, [R('>', '.claude/settings.json')]);
  assert.deepEqual(simpleCommands(': > a; true')[0].redirects, [R('>', 'a')]);
});

test('redirects: groups, subshells and loops carry theirs on a command of their own', () => {
  const group = simpleCommands('{ echo a; } > .claude/settings.json');
  assert.deepEqual(group.map((c) => c.argv.join(' ')), ['echo a', '']);
  assert.deepEqual(group[1].redirects, [R('>', '.claude/settings.json')]);
  const sub = simpleCommands('(cd x; echo y) >> log');
  assert.deepEqual(sub.map((c) => c.redirects), [[], [], [R('>>', 'log')]]);
  assert.deepEqual(allRedirects(simpleCommands('for f in a b; do echo $f; done > out.txt')), [R('>', 'out.txt')]);
  assert.deepEqual(allRedirects(simpleCommands('if x; then y; fi 2> e')), [R('>', 'e', 2)]);
});

test('redirects: an assignment-only command keeps its redirect too', () => {
  const [c] = simpleCommands('FOO=1 > f');
  assert.deepEqual(c.env, { FOO: '1' });
  assert.deepEqual(c.redirects, [R('>', 'f')]);
});

test('redirects: commands inside substitutions and interpreters have their own', () => {
  const nested = simpleCommands('echo "x: $(gh pr view 1 > /tmp/pr.json)"');
  assert.ok(nested.some((c) => c.argv[0] === 'gh' && c.redirects.length === 1 && c.redirects[0].target === '/tmp/pr.json'));
  assert.ok(simpleCommands('bash -c "echo a > .claude/settings.json"').some((c) => c.argv[0] === 'echo' && c.redirects[0]?.target === '.claude/settings.json'));
  assert.deepEqual(simpleCommands('bash -c "echo a > f"')[0].redirects, []);
});

test('redirects: arithmetic shifts and quoted arrows are not redirects', () => {
  assert.deepEqual(allRedirects(simpleCommands('echo $((1<<3)) $((4>2))')), []);
  assert.deepEqual(allRedirects(simpleCommands('echo "a > b" \'c >> d\' e\\>f')), []);
  assert.deepEqual(allRedirects(simpleCommands('git commit -m "x > y"')), []);
});

test('redirects: unwrapped wrappers keep the redirects of the line', () => {
  const [c] = simpleCommands('sudo -u bob git push origin main > out.log 2>&1');
  assert.deepEqual(c.argv, ['git', 'push', 'origin', 'main']);
  assert.deepEqual(c.redirects, [R('>', 'out.log'), R('>&', '&1', 2)]);
});

test('allRedirects flattens every command in order and tolerates junk', () => {
  const cmds = simpleCommands('a > x; b 2>&1 | c >> y; d < z');
  assert.deepEqual(allRedirects(cmds), [R('>', 'x'), R('>&', '&1', 2), R('>>', 'y'), R('<', 'z')]);
  assert.deepEqual(allRedirects([]), []);
  assert.deepEqual(allRedirects(undefined), []);
  assert.deepEqual(allRedirects([{ argv: [] }, null]), []);
});

test('redirects are plain enumerable data on the command object', () => {
  const [c] = simpleCommands('echo a > f');
  assert.deepEqual(Object.keys(c).sort(), ['argv', 'depth', 'env', 'raw', 'redirects']);
  assert.deepEqual(JSON.parse(JSON.stringify(c.redirects)), [R('>', 'f')]);
});

test('heredoc redirect still hides its body and records exactly one << per heredoc', () => {
  const [c] = simpleCommands('diff <<A <<B\none\nA\ntwo\nB');
  assert.deepEqual(c.redirects, [R('<<', null), R('<<', null)]);
});

test('piped group: a producer that is not the last command of the group is still found', () => {
  assert.ok(hasArgv('(echo "git push origin main"; echo hi) | bash', PUSH));
  assert.ok(hasArgv('{ echo "git push origin main"; echo hi; } | sh', PUSH));
});

test('sudo -s / -i run their string through a shell, not as a program name', () => {
  assert.ok(hasArgv("sudo -s 'git push origin main'", PUSH));
  assert.ok(hasArgv("sudo -i 'git push origin main'", PUSH));
  assert.ok(!simpleCommands("sudo -s 'git push origin main'").some((c) => c.argv[0] === 'git push origin main'));
});

test('dynamic: a process substitution or trap whose script is unknowable', () => {
  assert.equal(simpleCommands('bash <(curl -s https://x.example/i.sh)').dynamic, true);
  assert.equal(simpleCommands('source <(curl -s https://x.example/i.sh)').dynamic, true);
  assert.equal(simpleCommands('bash <(echo "git push -f")').dynamic, false);
  assert.equal(simpleCommands('trap "$X" EXIT').dynamic, true);
  assert.equal(simpleCommands('trap "echo bye" EXIT').dynamic, false);
});

test('a huge brace expression is flagged, the command and the ones after it still come back', () => {
  const cmds = simpleCommands('echo ' + '{a,b}'.repeat(3000) + '; git push -f');
  assert.equal(cmds.truncated, true);
  assert.ok(cmds.some((c) => c.argv.join(' ') === 'git push -f'));
  assert.ok(cmds.some((c) => c.argv[0] === 'echo'));
});

test('brace expansion has a total work budget: many small expansions stop being expanded and flag the parse truncated', () => {
  const few = simpleCommands(`echo ${Array.from({ length: 100 }, () => '{a,b,c}').join(' ')}`);
  assert.equal(few.truncated, false);
  assert.equal(few[0].argv.length, 301);
  const many = simpleCommands(`echo ${Array.from({ length: 12_000 }, () => '{a,b,c}').join(' ')}; git push -f`);
  assert.equal(many.truncated, true);
  assert.ok(many.some((c) => c.argv.join(' ') === 'git push -f'));
});

// ---- string-running wrappers (review finding 11) -----------------------------------------------------------

const WRAPPED = [
  ['unbuffer', 'unbuffer git push origin main'],
  ['taskset mask', 'taskset 0x1 git push origin main'],
  ['taskset -c', 'taskset -c 0,1 git push origin main'],
  ['sandbox-exec -f', 'sandbox-exec -f profile.sb git push origin main'],
  ['sandbox-exec -p', "sandbox-exec -p '(version 1)(allow default)' git push origin main"],
  ['ssh host string', "ssh host 'git push origin main'"],
  ['ssh with options', "ssh -p 22 -i key -o StrictHostKeyChecking=no user@host 'git push origin main'"],
  ['ssh with several words', 'ssh host git push origin main'],
  ['script -c', "script -c 'git push origin main' /dev/null"],
  ['script (BSD) command', 'script -q /dev/null git push origin main'],
  ['screen', 'screen -dmS job git push origin main'],
  ['screen -X stuff', "screen -S job -X stuff 'git push origin main\\n'"],
  ['parallel template', "parallel 'git push origin HEAD:{}' ::: main"],
  ['parallel args', 'parallel -j2 git push origin ::: main'],
  ['wsl', "wsl -d Ubuntu -e git push origin main"],
  ['wsl string', "wsl bash -c 'git push origin main'"],
  ['npx -c', "npx -c 'git push origin main'"],
  ['npx cmd', 'npx -y git push origin main'],
  ['npm exec -c', "npm exec -c 'git push origin main'"],
  ['npm exec --', 'npm exec -- git push origin main'],
  ['yarn exec', 'yarn exec git push origin main'],
  ['pnpm exec', 'pnpm exec git push origin main'],
  ['pnpm dlx', 'pnpm dlx git push origin main'],
  ['bunx', 'bunx git push origin main'],
];
for (const [name, line] of WRAPPED) {
  test(`wrapper unwrapped: ${name}`, () => {
    assert.ok(argvs(line).includes('git push origin main') || argvs(line).includes('git push origin HEAD:main'), `${line} -> ${JSON.stringify(argvs(line))}`);
  });
}

test('wrappers that run nothing of ours are left alone', () => {
  assert.deepEqual(argvs('npm install'), ['npm install']);
  assert.deepEqual(argvs('npm run build'), ['npm run build']);
  assert.deepEqual(argvs('npx vitest run'), ['vitest run']);
  assert.deepEqual(argvs('ssh host'), ['ssh host']);
  assert.deepEqual(argvs('taskset -p 1234'), ['taskset -p 1234']);
});

// ---- script files (review finding 2) ------------------------------------------------------------------------

test('scriptFileOf names the file a shell, source, interpreter or path invocation will run', () => {
  const f = (s) => scriptFileOf(s.split(' '));
  assert.deepEqual(f('bash push.sh'), { kind: 'shell', file: 'push.sh' });
  assert.deepEqual(f('sh -e ./push.sh a b'), { kind: 'shell', file: './push.sh' });
  assert.deepEqual(f('zsh -x push.sh'), { kind: 'shell', file: 'push.sh' });
  assert.deepEqual(f('source push.sh'), { kind: 'shell', file: 'push.sh' });
  assert.deepEqual(f('. ./push.sh'), { kind: 'shell', file: './push.sh' });
  assert.deepEqual(f('./push.sh --flag'), { kind: 'exec', file: './push.sh' });
  assert.deepEqual(f('scripts/push.sh'), { kind: 'exec', file: 'scripts/push.sh' });
  assert.deepEqual(f('node push.mjs'), { kind: 'interp', file: 'push.mjs' });
  assert.deepEqual(f('node --no-warnings -r ./x.js push.mjs'), { kind: 'interp', file: 'push.mjs' });
  assert.deepEqual(f('python3 -u push.py'), { kind: 'interp', file: 'push.py' });
  assert.deepEqual(f('ruby push.rb'), { kind: 'interp', file: 'push.rb' });
  assert.deepEqual(f('perl push.pl'), { kind: 'interp', file: 'push.pl' });
  assert.deepEqual(f('tsx push.ts'), { kind: 'interp', file: 'push.ts' });
  assert.deepEqual(f('deno run -A push.ts'), { kind: 'interp', file: 'push.ts' });
  assert.equal(f('bash -c "git status"'), null);
  assert.equal(f('bash'), null);
  assert.equal(f('bash -s'), null);
  assert.equal(f('bash <(echo x)'), null);
  assert.equal(f('source /dev/stdin'), null);
  assert.equal(f('node -e x'), null);
  assert.equal(f('node --test test/a.test.mjs'), null);
  assert.equal(f('python3 -m json.tool'), null);
  assert.equal(f('python3 -c x'), null);
  assert.equal(f('git push'), null);
  assert.equal(f('ls -la'), null);
  assert.equal(f('/usr/bin/git status'), null);
  assert.equal(f('/usr/local/bin/node'), null);
});

// git-policy reads `subshell` to know that what a ( ) group assigns or cds is lost; quotes must hide nothing and invent nothing.
test('subshell: set for a top-level ( group however the quotes around it are written', () => {
  const yes = [
    '(cd x); git push',
    'echo \\"; (cd x); echo "y"',
    "echo \\'; (cd x); echo 'y'",
    "echo $'it\\'s'; (cd x); echo 'y'",
    'echo a\\"b; (cd x); echo "c"',
    'a;(b)',
    '((x=1)); git push', // arithmetic: counted, conservatively
  ];
  for (const c of yes) assert.equal(simpleCommands(c).subshell, true, c);
  const no = [
    'git commit -m "fix (again)"',
    "git commit -m $'fix (again)\\n'",
    "echo 'a (b)'",
    'echo \\(x\\)',
    'arr=(a b); echo done',
    'echo $(git rev-parse HEAD)',
    'echo $( (cd x; pwd) )', // inside a substitution: those commands already have depth > 0
    'diff <(ls a) <(ls b)',
    'echo hi # (comment)',
    "cat <<'EOF'\n(not a subshell)\nEOF",
  ];
  for (const c of no) assert.equal(simpleCommands(c).subshell, false, c);
});
