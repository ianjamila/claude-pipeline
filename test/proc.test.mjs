import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run, runShell, splitCommand, escapeArgument, escapeCommand, quoteForCmd, planSpawn,
  gh, ghJson, GhError, codexCommand,
} from '../pipeline/lib/proc.mjs';

const fakeGh = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.mjs');
const scratch = () => mkdtempSync(join(tmpdir(), 'cp-proc-'));

// Writes a fake-gh script + log path and returns the env that points `gh()` at the fake.
function fakeGhEnv(entries) {
  const dir = scratch();
  const script = join(dir, 'script.json');
  const log = join(dir, 'log.jsonl');
  writeFileSync(script, JSON.stringify(entries));
  return {
    log,
    env: {
      PIPELINE_GH: `node "${fakeGh}"`,
      PIPELINE_FAKE_GH_SCRIPT: script,
      PIPELINE_FAKE_GH_LOG: log,
    },
  };
}

test('run captures stdout and exit code', () => {
  const r = run('node', ['-e', 'process.stdout.write("hi")']);
  assert.deepEqual(r, { code: 0, stdout: 'hi', stderr: '', timedOut: false });
});

test('run reports a non-zero exit code and stderr', () => {
  const r = run('node', ['-e', 'process.stderr.write("bad"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'bad');
  assert.equal(r.timedOut, false);
});

test('run kills on timeout and flags it', () => {
  const r = run('node', ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

test('run pipes input to stdin', () => {
  const r = run('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' });
  assert.equal(r.stdout, 'abc');
  assert.equal(r.code, 0);
});

test('run merges env over process.env and honours cwd', () => {
  const dir = realpathSync(scratch());
  const r = run('node', ['-e', 'process.stdout.write(process.env.CP_FOO + "|" + process.cwd())'], {
    env: { CP_FOO: 'bar' }, cwd: dir,
  });
  assert.equal(r.stdout, `bar|${dir}`);
});

test('run on a missing command returns a non-zero code and a message instead of throwing', () => {
  const r = run('cp-definitely-not-a-command-xyz', []);
  assert.notEqual(r.code, 0);
  assert.notEqual(r.stderr, '');
  assert.equal(r.timedOut, false);
});

test('runShell runs a shell command line', () => {
  const r = runShell('echo hi');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hi/);
});

test('runShell reports exit code, env and timeout', () => {
  assert.equal(runShell('exit 3').code, 3);
  const e = runShell('node -e "process.stdout.write(process.env.CP_BAR)"', { env: { CP_BAR: 'baz' } });
  assert.equal(e.stdout, 'baz');
  const t = runShell('node -e "setTimeout(()=>{},5000)"', { timeoutMs: 300 });
  assert.equal(t.timedOut, true);
  assert.notEqual(t.code, 0);
});

test('splitCommand splits on whitespace and double quotes', () => {
  assert.deepEqual(splitCommand('node "/a b/fake.mjs" --x'), ['node', '/a b/fake.mjs', '--x']);
  assert.deepEqual(splitCommand('  a   b  '), ['a', 'b']);
  assert.deepEqual(splitCommand(''), []);
});

test('splitCommand handles single quotes, escapes and empty args', () => {
  assert.deepEqual(splitCommand("node '/a b/x.mjs' 'it\\s'"), ['node', '/a b/x.mjs', 'it\\s']);
  assert.deepEqual(splitCommand('a\\ b c'), ['a b', 'c']);
  assert.deepEqual(splitCommand('say "he said \\"hi\\""'), ['say', 'he said "hi"']);
  assert.deepEqual(splitCommand("say 'it\"s'"), ['say', 'it"s']);
  assert.deepEqual(splitCommand('a "" b'), ['a', '', 'b']);
  assert.deepEqual(splitCommand('pre"mid dle"post'), ['premid dlepost']);
});

test('splitCommand throws on an unterminated quote', () => {
  assert.throws(() => splitCommand('a "b'), /unterminated/i);
  assert.throws(() => splitCommand("a 'b"), /unterminated/i);
});

test('splitCommand keeps Windows backslash paths intact', () => {
  assert.deepEqual(splitCommand('node C:\\a\\b.mjs', 'win32'), ['node', 'C:\\a\\b.mjs']);
  assert.deepEqual(splitCommand('node "C:\\a b\\x.mjs" --y', 'win32'), ['node', 'C:\\a b\\x.mjs', '--y']);
  assert.deepEqual(splitCommand('say "a\\"b"', 'win32'), ['say', 'a"b']);
  // inside double quotes a non-special backslash stays literal on POSIX too
  assert.deepEqual(splitCommand('node "C:\\a b\\x.mjs"', 'linux'), ['node', 'C:\\a b\\x.mjs']);
});

// Expected strings below follow cross-spawn's algorithm (lib/util/escape.js) applied by hand:
//   1. backslashes before a " are doubled and the " gets a backslash; trailing backslashes are doubled
//   2. wrap the arg in double quotes
//   3. caret-escape every cmd metachar: ( ) [ ] % ! ^ " ` < > & | ; , space * ?  (the wrapping quotes too)
//   4. for batch targets, repeat step 3 once more (a .cmd re-parses its arguments)
test('escapeArgument: single escape (direct cmd.exe /c)', () => {
  assert.equal(escapeArgument('a b', false), String.raw`^"a^ b^"`); // "a b" -> ^"a^ b^"
  assert.equal(escapeArgument('x&y', false), String.raw`^"x^&y^"`);
  assert.equal(escapeArgument('100%', false), String.raw`^"100^%^"`);
  assert.equal(escapeArgument('bang!', false), String.raw`^"bang^!^"`);
  // q"q -> q\"q -> "q\"q" -> the backslash is not a metachar, the quotes are
  assert.equal(escapeArgument('q"q', false), String.raw`^"q\^"q^"`);
  // C:\a b\ -> trailing backslash doubled so it cannot swallow the closing quote: "C:\a b\\"
  assert.equal(escapeArgument('C:\\a b\\', false), String.raw`^"C:\a^ b\\^"`);
  assert.equal(escapeArgument('', false), '^"^"');
  assert.equal(escapeArgument(42, false), '^"42^"');
});

test('escapeArgument: double escape (batch files re-parse their arguments)', () => {
  // step 3 applied twice: every ^ from the first pass is itself caret-escaped
  assert.equal(escapeArgument('a b', true), String.raw`^^^"a^^^ b^^^"`);
  assert.equal(escapeArgument('x&y', true), String.raw`^^^"x^^^&y^^^"`);
  assert.equal(escapeArgument('100%', true), String.raw`^^^"100^^^%^^^"`);
  assert.equal(escapeArgument('bang!', true), String.raw`^^^"bang^^^!^^^"`);
  assert.equal(escapeArgument('q"q', true), String.raw`^^^"q\^^^"q^^^"`);
  assert.equal(escapeArgument('C:\\a b\\', true), String.raw`^^^"C:\a^^^ b\\^^^"`);
});

test('escapeCommand caret-escapes metachars, including spaces, but leaves backslashes and colons', () => {
  assert.equal(escapeCommand(String.raw`C:\Program Files\nodejs\npm.cmd`), String.raw`C:\Program^ Files\nodejs\npm.cmd`);
  assert.equal(escapeCommand('a&b(c)'), 'a^&b^(c^)');
});

test('quoteForCmd joins double-escaped args with spaces', () => {
  assert.equal(quoteForCmd(['a b', 'x&y']), `${escapeArgument('a b', true)} ${escapeArgument('x&y', true)}`);
  assert.equal(quoteForCmd([]), '');
});

// Model of what the Windows side does to an escaped arg: cmd.exe drops one caret layer per parse
// (two for a batch file), then the MS C runtime unquotes it. If the escaping is right, the
// program receives exactly the original string back.
const stripCarets = (s) => s.replace(/\^(.)/g, '$1');
function crtUnquote(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    let bs = 0;
    while (s[i] === '\\') { bs++; i++; }
    if (s[i] === '"') {
      out += '\\'.repeat(Math.floor(bs / 2));
      if (bs % 2) out += '"';
      i++;
    } else {
      out += '\\'.repeat(bs);
      if (i < s.length) out += s[i++];
    }
  }
  return out;
}

test('escapeArgument round-trips tricky args through the cmd.exe + C runtime model', () => {
  const tricky = [
    'a b', 'x&y', '100%', 'bang!', 'q"q', 'C:\\a b\\', '', '"', '""', '^caret', '(paren)', 'pipe|redir>',
    String.raw`a\\"b`, // two backslashes, then a quote
    '\\\\\\\\', // only backslashes (all trailing)
    'trail\\\\', // two trailing backslashes
    'a\\b\\\\c"d\\', // mixed runs
    '\\\\server\\share\\dir\\',
  ];
  for (const arg of tricky) {
    assert.equal(crtUnquote(stripCarets(escapeArgument(arg, false))), arg, `single: ${JSON.stringify(arg)}`);
    assert.equal(crtUnquote(stripCarets(stripCarets(escapeArgument(arg, true)))), arg, `double: ${JSON.stringify(arg)}`);
  }
});

test('escapeArgument stays linear on long backslash runs', () => {
  const t0 = Date.now();
  escapeArgument('\\'.repeat(200000), true);
  assert.ok(Date.now() - t0 < 2000);
});

test('planSpawn: POSIX runs the command directly', () => {
  assert.deepEqual(planSpawn('git', ['status'], { platform: 'linux' }), {
    file: 'git', args: ['status'], windowsVerbatimArguments: false,
  });
});

test('planSpawn: Windows .exe is spawned directly', () => {
  const resolve = () => 'C:\\Program Files\\Git\\cmd\\git.exe';
  assert.deepEqual(planSpawn('git', ['status'], { platform: 'win32', resolve }), {
    file: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['status'], windowsVerbatimArguments: false,
  });
});

test('planSpawn: Windows .cmd shim goes through cmd.exe with cross-spawn quoting', () => {
  const resolve = () => String.raw`C:\Program Files\nodejs\npm.cmd`;
  const plan = planSpawn('npm', ['run', 'x y'], { platform: 'win32', resolve });
  assert.equal(plan.file, 'cmd.exe');
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  // command escaped once, args double-escaped, whole line wrapped in one extra pair of quotes (cmd /s strips it)
  assert.equal(plan.args[3], String.raw`"C:\Program^ Files\nodejs\npm.cmd ^^^"run^^^" ^^^"x^^^ y^^^""`);
  assert.equal(plan.args.length, 4);
});

test('planSpawn: Windows .bat target with a forward-slash path is normalised to backslashes', () => {
  const plan = planSpawn('C:/tools/run it.bat', ['x'], { platform: 'win32' });
  assert.equal(plan.file, 'cmd.exe');
  assert.equal(plan.args[3], String.raw`"C:\tools\run^ it.bat ^^^"x^^^""`);
});

test('planSpawn: Windows command that cannot be resolved is passed through', () => {
  const plan = planSpawn('nope', ['a'], { platform: 'win32', resolve: () => null });
  assert.deepEqual(plan, { file: 'nope', args: ['a'], windowsVerbatimArguments: false });
});

test('gh runs the PIPELINE_GH override and logs argv', () => {
  const { env, log } = fakeGhEnv([{ match: '^pr view 1$', stdoutJson: { number: 1 } }]);
  const r = gh(['pr', 'view', '1'], { env });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { number: 1 });
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].argv, ['pr', 'view', '1']);
  assert.equal(typeof lines[0].cwd, 'string');
});

test('fake gh forwards stdin to the log', () => {
  const { env, log } = fakeGhEnv([{ match: '^pr comment', stdout: 'ok' }]);
  const r = gh(['pr', 'comment', '1', '--body-file', '-'], { env, input: 'hello body' });
  assert.equal(r.stdout, 'ok');
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).stdin, 'hello body');
});

test('fake gh exits 99 when nothing matches', () => {
  const { env } = fakeGhEnv([{ match: '^nothing$' }]);
  const r = gh(['pr', 'list'], { env });
  assert.equal(r.code, 99);
  assert.match(r.stderr, /fake-gh: no match for pr list/);
});

test('fake gh uses the first matching entry', () => {
  const { env } = fakeGhEnv([
    { match: '^pr ', stdout: 'first' },
    { match: '^pr view', stdout: 'second' },
  ]);
  assert.equal(gh(['pr', 'view', '1'], { env }).stdout, 'first');
});

test('ghJson parses stdout', () => {
  const { env } = fakeGhEnv([{ match: '^pr view 1$', stdoutJson: { number: 1 } }]);
  assert.deepEqual(ghJson(['pr', 'view', '1'], { env }), { number: 1 });
});

test('ghJson throws GhError with code, stderr and args on failure', () => {
  const { env } = fakeGhEnv([{ match: '^pr view', code: 1, stderr: 'boom' }]);
  assert.throws(
    () => ghJson(['pr', 'view', '2'], { env }),
    (err) => {
      assert.ok(err instanceof GhError);
      assert.ok(err instanceof Error);
      assert.equal(err.code, 1);
      assert.equal(err.stderr, 'boom');
      assert.deepEqual(err.args, ['pr', 'view', '2']);
      assert.match(err.message, /boom/);
      return true;
    },
  );
});

test('ghJson throws GhError when stdout is not JSON', () => {
  const { env } = fakeGhEnv([{ match: '.*', stdout: 'not json' }]);
  assert.throws(() => ghJson(['x'], { env }), GhError);
});

test('codexCommand defaults to codex and honours PIPELINE_CODEX', () => {
  assert.deepEqual(codexCommand({}), { cmd: 'codex', prefixArgs: [] });
  assert.deepEqual(codexCommand({ PIPELINE_CODEX: 'node "/a b/fake-codex.mjs" --flag' }), {
    cmd: 'node', prefixArgs: ['/a b/fake-codex.mjs', '--flag'],
  });
});

test('codexCommand reads process.env by default', () => {
  const prev = process.env.PIPELINE_CODEX;
  try {
    process.env.PIPELINE_CODEX = 'my-codex --x';
    assert.deepEqual(codexCommand(), { cmd: 'my-codex', prefixArgs: ['--x'] });
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_CODEX;
    else process.env.PIPELINE_CODEX = prev;
  }
});

// Real round trip through a .cmd shim. Only meaningful on Windows (runs on the Windows CI runner).
test('run passes awkward args through a real .cmd shim unchanged', { skip: process.platform !== 'win32' }, () => {
  const shim = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-args.cmd');
  const input = ['a b', 'x&y', '100%', 'bang!', 'q"q', 'C:\\t\\'];
  const r = run(shim, input);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), input);
});
