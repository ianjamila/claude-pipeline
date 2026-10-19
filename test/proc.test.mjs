import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run, runAsync, runShell, runShellAsync, splitCommand, escapeArgument, escapeCommand, quoteForCmd, planSpawn,
  cmdExe, createResolver, toResult, shellResult,
  gh, ghJson, GhError, codexCommand, findOnPosixPath, envWithGhDir,
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
  assert.deepEqual(r, { code: 0, stdout: 'hi', stderr: '', timedOut: false, signal: null });
});

test('run reports a non-zero exit code and stderr', () => {
  const r = run('node', ['-e', 'process.stderr.write("bad"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'bad');
  assert.equal(r.timedOut, false);
});

test('run reports the signal that killed the child (code alone cannot tell it from a plain exit 1)', { skip: process.platform === 'win32' }, () => {
  const r = run('node', ['-e', "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.code, 1);
  assert.equal(r.stderr, '');
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
  const dir = realpathSync.native(scratch());
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

test('shellResult maps cmd.exe "not recognized" (exit 1) to 127 on Windows only', () => {
  const miss = { code: 1, stdout: '', stderr: "'nope' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", timedOut: false };
  assert.equal(shellResult(miss, 'win32').code, 127);
  assert.equal(shellResult(miss, 'linux').code, 1);
  assert.equal(shellResult({ ...miss, code: 2 }, 'win32').code, 2);
  assert.equal(shellResult({ ...miss, stderr: 'assertion failed' }, 'win32').code, 1);
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
  assert.deepEqual(splitCommand('a\\ b c', 'linux'), ['a b', 'c']);
  assert.deepEqual(splitCommand('a\\ b c', 'win32'), ['a\\', 'b', 'c']); // a Windows backslash is a path separator
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
  const plan = planSpawn('npm', ['run', 'x y'], { platform: 'win32', resolve, env: {} });
  assert.equal(plan.file, String.raw`C:\Windows\System32\cmd.exe`);
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  // command escaped once, args double-escaped, whole line wrapped in one extra pair of quotes (cmd /s strips it)
  assert.equal(plan.args[3], String.raw`"C:\Program^ Files\nodejs\npm.cmd ^^^"run^^^" ^^^"x^^^ y^^^""`);
  assert.equal(plan.args.length, 4);
});

test('planSpawn: Windows .bat target with a forward-slash path is normalised to backslashes', () => {
  const plan = planSpawn('C:/tools/run it.bat', ['x'], { platform: 'win32', env: {} });
  assert.equal(plan.file, String.raw`C:\Windows\System32\cmd.exe`);
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

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const trapSigterm = join(fixtures, 'trap-sigterm.mjs');
// The fixture sleeps 30 s unless killed, so any bound well under that proves the SIGKILL; the old 1.5 s left only 1 s for two process spawns, tight on a loaded Windows runner.
const KILL_WITHIN_MS = 10_000;
const spawnSleeper = join(fixtures, 'spawn-sleeper.mjs');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); // a zombie is already dead
    } catch {
      return false;
    }
  }
  return true;
}

async function waitUntilDead(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

test('run SIGKILLs on timeout: a child that traps SIGTERM and exits 0 still cannot report success', () => {
  const marker = join(scratch(), 'sigterm.marker');
  const t0 = Date.now();
  const r = run('node', [trapSigterm, marker], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < KILL_WITHIN_MS, `took ${Date.now() - t0} ms`);
  assert.equal(existsSync(marker), false, 'the child was sent SIGTERM, not SIGKILL');
});

test('runShell SIGKILLs on timeout and never reports exit 0', () => {
  const marker = join(scratch(), 'sigterm.marker');
  const t0 = Date.now();
  const r = runShell(`node "${trapSigterm}" "${marker}"`, { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < KILL_WITHIN_MS, `took ${Date.now() - t0} ms`);
  assert.equal(existsSync(marker), false, 'the shell command was sent SIGTERM, not SIGKILL');
});

test('toResult: a timeout is never exit 0, whatever status the child reported', () => {
  const timeout = { code: 'ETIMEDOUT' };
  assert.equal(toResult({ status: 0, error: timeout }).code, 124);
  assert.equal(toResult({ status: null, error: timeout }).code, 124);
  assert.equal(toResult({ status: 3, error: timeout }).code, 3);
  assert.equal(toResult({ status: 0, error: timeout }).timedOut, true);
  assert.equal(toResult({ status: 0 }).code, 0);
  assert.equal(toResult({ status: null }).code, 1);
  assert.equal(toResult({ status: null, error: new Error('spawn x ENOENT') }).stderr, 'spawn x ENOENT');
});

test('runShell honours input', () => {
  const r = runShell('node -e "process.stdin.pipe(process.stdout)"', { input: 'from stdin' });
  assert.equal(r.stdout, 'from stdin');
});

test('runShellAsync captures output, exit code, env, cwd and input', async () => {
  const dir = realpathSync.native(scratch());
  const ok = await runShellAsync('node -e "process.stdout.write(process.env.CP_A + \'|\' + process.cwd())"', {
    env: { CP_A: 'x' }, cwd: dir,
  });
  assert.deepEqual(ok, { code: 0, stdout: `x|${dir}`, stderr: '', timedOut: false });
  const bad = await runShellAsync('node -e "process.stderr.write(\'e\'); process.exit(4)"');
  assert.equal(bad.code, 4);
  assert.equal(bad.stderr, 'e');
  const echoed = await runShellAsync('node -e "process.stdin.pipe(process.stdout)"', { input: 'piped' });
  assert.equal(echoed.stdout, 'piped');
});

test('runShellAsync SIGKILLs a command that traps SIGTERM', async () => {
  const t0 = Date.now();
  const r = await runShellAsync(`node "${trapSigterm}"`, { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < KILL_WITHIN_MS, `took ${Date.now() - t0} ms`);
});

test('runShellAsync timeout kills the whole process tree, not just the direct child', async () => {
  const pidFile = join(scratch(), 'grandchild.pid');
  const r = await runShellAsync(`node "${spawnSleeper}" "${pidFile}"`, { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(await waitUntilDead(pid), true, `grandchild ${pid} survived the timeout`);
});

test('runAsync passes args verbatim (no shell), env, cwd and input', async () => {
  const dir = realpathSync.native(scratch());
  const r = await runAsync(process.execPath, ['-e', 'process.stdout.write(process.argv[1] + "|" + process.env.CP_A + "|" + process.cwd())', 'a b;"c"'], {
    env: { CP_A: 'x' }, cwd: dir,
  });
  assert.deepEqual(r, { code: 0, stdout: `a b;"c"|x|${dir}`, stderr: '', timedOut: false });
  assert.equal((await runAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' })).stdout, 'piped');
  assert.equal((await runAsync(process.execPath, ['-e', 'process.exit(4)'])).code, 4);
});

test('runAsync: a missing binary resolves with a non-zero code and the spawn error, it never rejects', async () => {
  const r = await runAsync(join(scratch(), 'no-such-binary'), ['x']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ENOENT/);
  assert.equal(r.timedOut, false);
});

test('runAsync timeout kills the whole process tree, not just the direct child', async () => {
  const pidFile = join(scratch(), 'grandchild-async.pid');
  const r = await runAsync(process.execPath, [spawnSleeper, pidFile], { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(await waitUntilDead(pid), true, `grandchild ${pid} survived the timeout`);
});

test('planSpawn: Windows .cmd rejects args cmd.exe cannot carry', () => {
  const resolve = () => String.raw`C:\x\tool.cmd`;
  const plan = (args) => planSpawn('tool', args, { platform: 'win32', resolve });
  assert.throws(() => plan(['line1\nline2']), /newline/i);
  assert.throws(() => plan(['a\rb']), /newline/i);
  assert.throws(() => plan(['x'.repeat(9000)]), /8191/);
  assert.doesNotThrow(() => plan(['x'.repeat(2000)]));
});

test('planSpawn: Windows .exe targets are not limited by cmd.exe rules', () => {
  const resolve = () => String.raw`C:\x\tool.exe`;
  const plan = planSpawn('tool', ['line1\nline2', 'x'.repeat(9000)], { platform: 'win32', resolve });
  assert.equal(plan.file, String.raw`C:\x\tool.exe`);
});

test('cmdExe prefers ComSpec and otherwise uses the absolute system path', () => {
  assert.equal(cmdExe({ ComSpec: String.raw`D:\Win\cmd.exe` }), String.raw`D:\Win\cmd.exe`);
  assert.equal(cmdExe({}), String.raw`C:\Windows\System32\cmd.exe`);
});

test('planSpawn launches an absolute cmd.exe, never the bare name', () => {
  const resolve = () => String.raw`C:\x\tool.cmd`;
  assert.equal(
    planSpawn('tool', [], { platform: 'win32', resolve, env: { ComSpec: String.raw`D:\Win\cmd.exe` } }).file,
    String.raw`D:\Win\cmd.exe`,
  );
  assert.equal(planSpawn('tool', [], { platform: 'win32', resolve, env: {} }).file, String.raw`C:\Windows\System32\cmd.exe`);
});

test('createResolver: searches from the temp dir, prefers executables, caches hits but not misses', () => {
  const calls = [];
  let hits = null;
  const resolve = createResolver((cmd, cwd) => { calls.push({ cmd, cwd }); return hits; });
  assert.equal(resolve('npm'), null);
  assert.equal(resolve('npm'), null);
  assert.equal(calls.length, 2, 'a miss must be looked up again');
  assert.equal(calls[0].cwd, tmpdir(), 'where must not search the repo directory');
  hits = [String.raw`C:\nodejs\npm`, String.raw`C:\nodejs\npm.cmd`];
  assert.equal(resolve('npm'), String.raw`C:\nodejs\npm.cmd`);
  assert.equal(resolve('npm'), String.raw`C:\nodejs\npm.cmd`);
  assert.equal(calls.length, 3, 'a hit is cached');
  assert.equal(resolve(String.raw`C:\tools\x.exe`), String.raw`C:\tools\x.exe`, 'explicit paths skip the lookup');
  assert.equal(calls.length, 3);
});

test('GhError carries timedOut and says so in its message', () => {
  const { env } = fakeGhEnv([]);
  const slow = { ...env, PIPELINE_GH: `node "${trapSigterm}"` };
  assert.throws(
    () => ghJson(['pr', 'view', '1'], { env: slow, timeoutMs: 500 }),
    (err) => {
      assert.ok(err instanceof GhError);
      assert.equal(err.timedOut, true);
      assert.notEqual(err.code, 0);
      assert.match(err.message, /timed out/);
      return true;
    },
  );
  const { env: failing } = fakeGhEnv([{ match: '.*', code: 1, stderr: 'boom' }]);
  assert.throws(() => ghJson(['x'], { env: failing }), (err) => err.timedOut === false && !/timed out/.test(err.message));
});

// Every cmd.exe metacharacter must come out caret-escaped (twice for batch targets); dropping one
// from META_CHARS must fail here. Expected shapes, with c the metachar in the arg "a<c>b":
//   single  ^"a^<c>b^"   double  ^^^"a^^^<c>b^^^"   (a " also gets the backslash: ...a\^"b...)
const META = ['(', ')', '[', ']', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', '*', '?', ' '];

test('escapeArgument caret-escapes every cmd metacharacter, one char at a time', () => {
  for (const c of META) {
    const bs = c === '"' ? '\\' : '';
    assert.equal(escapeArgument(`a${c}b`, false), `^"a${bs}^${c}b^"`, `single, char ${JSON.stringify(c)}`);
    assert.equal(escapeArgument(`a${c}b`, true), `^^^"a${bs}^^^${c}b^^^"`, `double, char ${JSON.stringify(c)}`);
  }
});

test('escapeArgument leaves ordinary punctuation alone', () => {
  for (const c of [':', '/', '.', '-', '_', '\\', '$', '{', '}', "'", '@', '#', '~', '+']) {
    assert.equal(escapeArgument(`a${c}b`, true), `^^^"a${c}b^^^"`, `char ${JSON.stringify(c)}`);
  }
});

test('escapeCommand caret-escapes every cmd metacharacter too', () => {
  for (const c of META) assert.equal(escapeCommand(`a${c}b`), `a^${c}b`, `char ${JSON.stringify(c)}`);
});

// Real round trip through a .cmd shim. Only meaningful on Windows (runs on the Windows CI runner).
test('run passes awkward args through a real .cmd shim unchanged', { skip: process.platform !== 'win32' }, () => {
  const shim = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-args.cmd');
  const input = ['a b', 'x&y', '100%', 'bang!', 'q"q', 'C:\\t\\'];
  const r = run(shim, input);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), input);
});

// gh on macOS: the hook's PATH lacks /opt/homebrew/bin, so a bare `gh` was ENOENT and an allowed gh action was denied.
const posixOnly = { skip: process.platform === 'win32' };
function fakeGhDir(out) {
  const dir = scratch();
  const file = join(dir, 'gh');
  writeFileSync(file, `#!/bin/sh\nprintf '${out}'\n`);
  chmodSync(file, 0o755);
  return dir;
}

test('gh falls back to a fixed install dir when the PATH lookup misses', posixOnly, () => {
  const emptyPath = scratch();
  const fallback = fakeGhDir('from-fallback');
  const r = gh(['issue', 'view', '1'], { env: { PATH: emptyPath, PIPELINE_GH: '' }, fallbackDirs: [fallback] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'from-fallback');
});

test('gh prefers the PATH hit over the fallback dirs', posixOnly, () => {
  const onPath = fakeGhDir('from-path');
  const fallback = fakeGhDir('from-fallback');
  const r = gh(['x'], { env: { PATH: onPath, PIPELINE_GH: '' }, fallbackDirs: [fallback] });
  assert.equal(r.stdout, 'from-path');
});

test('gh still fails (non-zero, nothing run) when neither PATH nor the fallback dirs hold gh', posixOnly, () => {
  const r = gh(['x'], { env: { PATH: scratch(), PIPELINE_GH: '' }, fallbackDirs: [scratch()] });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
});

test('gh never takes a cwd-relative or non-executable fallback entry', posixOnly, () => {
  const dir = scratch();
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf pwned\n'); // present but not executable
  const r = gh(['x'], { env: { PATH: scratch(), PIPELINE_GH: '' }, fallbackDirs: [dir, '.', ''], cwd: dir });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
});

test('gh with a PIPELINE_GH override does not consult the fallback dirs', posixOnly, () => {
  const fallback = fakeGhDir('from-fallback');
  const r = gh(['x'], { env: { PATH: scratch(), PIPELINE_GH: 'cp-no-such-gh-xyz' }, fallbackDirs: [fallback] });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
});

test('findOnPosixPath skips empty and relative entries even when the cwd holds an executable gh', posixOnly, () => {
  const dir = realpathSync.native(fakeGhDir('planted'));
  const before = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(findOnPosixPath('gh', `${['', '.', 'rel'].join(path.delimiter)}`, ['.', '', 'rel']), null);
    assert.equal(findOnPosixPath('gh', dir, []), join(dir, 'gh'));
  } finally {
    process.chdir(before);
  }
});

// Project commands the pipeline spawns (merge.command, smoke) inherit the caller PATH; when gh is only in a fallback dir the
// pipeline finds it for itself, so the command gets that dir appended or its own `gh` was ENOENT.
test('envWithGhDir appends the fallback dir that holds gh when PATH lacks it', posixOnly, () => {
  const emptyPath = scratch();
  const fallback = fakeGhDir('x');
  const env = { PATH: emptyPath, KEEP: '1', PIPELINE_GH: '' };
  const out = envWithGhDir(env, { fallbackDirs: [fallback] });
  assert.equal(out.PATH, [emptyPath, fallback].join(path.delimiter));
  assert.equal(out.KEEP, '1');
  assert.notEqual(out, env);
  assert.equal(env.PATH, emptyPath, 'the input is not mutated');
});

test('envWithGhDir appends (never prepends) and works for an empty PATH', posixOnly, () => {
  const fallback = fakeGhDir('x');
  assert.equal(envWithGhDir({ PATH: '', PIPELINE_GH: '' }, { fallbackDirs: [fallback] }).PATH, fallback);
});

test('envWithGhDir leaves PATH alone when gh is already on it (a copy, same PATH)', posixOnly, () => {
  const onPath = fakeGhDir('x');
  const fallback = fakeGhDir('y');
  const env = { PATH: onPath, PIPELINE_GH: '' };
  const out = envWithGhDir(env, { fallbackDirs: [fallback] });
  assert.equal(out.PATH, onPath);
  assert.notEqual(out, env);
});

test('envWithGhDir leaves PATH alone when gh is nowhere', posixOnly, () => {
  const p = scratch();
  assert.equal(envWithGhDir({ PATH: p, PIPELINE_GH: '' }, { fallbackDirs: [scratch()] }).PATH, p);
});

test('envWithGhDir leaves PATH alone when PIPELINE_GH overrides gh', posixOnly, () => {
  const p = scratch();
  const fallback = fakeGhDir('x');
  assert.equal(envWithGhDir({ PATH: p, PIPELINE_GH: 'node fake-gh.mjs' }, { fallbackDirs: [fallback] }).PATH, p);
});

test('envWithGhDir never counts or appends a relative or empty dir, and adds no duplicate', posixOnly, () => {
  const dir = realpathSync.native(fakeGhDir('planted'));
  const before = process.cwd();
  process.chdir(dir);
  try {
    const p = ['', '.', 'rel'].join(path.delimiter);
    assert.equal(envWithGhDir({ PATH: p, PIPELINE_GH: '' }, { fallbackDirs: ['.', '', 'rel'] }).PATH, p);
    // once the dir is on PATH, gh resolves from PATH and nothing is added a second time
    const out = envWithGhDir({ PATH: p, PIPELINE_GH: '' }, { fallbackDirs: [dir] });
    assert.equal(out.PATH, [p, dir].join(path.delimiter));
    assert.equal(envWithGhDir(out, { fallbackDirs: [dir] }).PATH, out.PATH);
  } finally {
    process.chdir(before);
  }
});

test('envWithGhDir reads PATH from process.env when the env has none, and tolerates no env', posixOnly, () => {
  const fallback = fakeGhDir('x');
  const saved = process.env.PATH;
  const savedGh = process.env.PIPELINE_GH;
  const p = scratch();
  process.env.PATH = p;
  delete process.env.PIPELINE_GH;
  try {
    assert.equal(envWithGhDir({}, { fallbackDirs: [fallback] }).PATH, [p, fallback].join(path.delimiter));
    assert.equal(envWithGhDir(undefined, { fallbackDirs: [fallback] }).PATH, [p, fallback].join(path.delimiter));
  } finally {
    process.env.PATH = saved;
    if (savedGh !== undefined) process.env.PIPELINE_GH = savedGh;
  }
});

test('envWithGhDir does nothing on win32', () => {
  const p = scratch();
  const out = envWithGhDir({ PATH: p, PIPELINE_GH: '' }, { fallbackDirs: [fakeGhDir('x')], platform: 'win32' });
  assert.equal(out.PATH, p);
});
