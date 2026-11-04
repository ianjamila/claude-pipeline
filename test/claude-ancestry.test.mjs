// Why: the installer's process-tree backstop (an agent that removes CLAUDECODE from the environment still has Claude Code
// as an ancestor). The lookup is injected, so these tests never read the real process table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasClaudeCodeAncestor, isClaudeCodeProcess, realLookup } from '../pipeline/lib/claude-ancestry.mjs';

const table = (rows) => (pid) => rows[pid] ?? null;

test('isClaudeCodeProcess: the claude binary by any path, or a JS runtime running its cli; not the desktop app or look-alikes', () => {
  for (const comm of ['claude', '/Users/u/.local/bin/claude', 'C:\\Users\\u\\bin\\claude.exe', '/opt/homebrew/bin/claude']) assert.equal(isClaudeCodeProcess({ comm }), true, comm);
  assert.equal(isClaudeCodeProcess({ comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }), true);
  assert.equal(isClaudeCodeProcess({ comm: '/usr/local/bin/node', args: '/usr/local/bin/node /home/u/.claude/local/claude' }), true);
  assert.equal(isClaudeCodeProcess({ comm: 'bun', args: 'bun /x/claude-code/cli.js' }), true);
  for (const info of [{ comm: 'Claude' }, { comm: 'claude-helper' }, { comm: 'node', args: 'node scripts/test.mjs' }, { comm: 'zsh' }, { comm: 'node' }, null, {}]) {
    assert.equal(isClaudeCodeProcess(info), false, JSON.stringify(info));
  }
});

test('hasClaudeCodeAncestor walks the parent chain and finds Claude Code at any height', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', args: 'node install.mjs' },
    800: { ppid: 700, comm: '/bin/zsh' },
    700: { ppid: 600, comm: 'sh' },
    600: { ppid: 500, comm: '/Users/u/.local/bin/claude' },
    500: { ppid: 1, comm: 'login' },
  };
  assert.equal(hasClaudeCodeAncestor({ startPid: 900, lookup: table(rows) }), true);
  assert.equal(hasClaudeCodeAncestor({ startPid: 500, lookup: table(rows) }), false, 'login is above claude, not below it');
});

test('hasClaudeCodeAncestor: no Claude Code on the chain, a failed lookup, a cycle and a long chain all end in false', () => {
  const clean = { 30: { ppid: 20, comm: 'zsh' }, 20: { ppid: 10, comm: 'Terminal' }, 10: { ppid: 1, comm: 'launchd' } };
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: table(clean) }), false);
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: () => null }), false, 'lookup failure falls back to the env check');
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: () => { throw new Error('no ps'); } }), false);
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: table({ 30: { ppid: 20, comm: 'a' }, 20: { ppid: 30, comm: 'b' } }) }), false, 'a cycle terminates');
  const long = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 2, { ppid: i + 3, comm: i === 90 ? 'claude' : 'sh' }]));
  assert.equal(hasClaudeCodeAncestor({ startPid: 2, lookup: table(long) }), false, 'bounded depth (claude is 90 hops up)');
  assert.equal(hasClaudeCodeAncestor({ startPid: 2, lookup: table(long), maxHops: 100 }), true);
  assert.equal(hasClaudeCodeAncestor({ startPid: 1, lookup: table(clean) }), false);
});

// ---- Windows: a recycled parent PID must not send the walk into an unrelated chain (#25) -----------------------------------
// The tests inject `created` (epoch ms) the way the win32 lookup reports it. The walk starts from the installer's parent
// (startPid) and looks up the installer's own process (ownPid) first to know when the first child began.
const win = (rows, extra = {}) => hasClaudeCodeAncestor({ startPid: 800, ownPid: 900, platform: 'win32', lookup: table(rows), ...extra });
const T = 1_730_000_000_000;

test('a parent created more than 2 s after its child is a recycled PID: the walk stops before a Claude Code further up', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', created: T },
    800: { ppid: 700, comm: 'cmd.exe', created: T + 60_000 }, // not the process that started 900: its PID was reused
    700: { ppid: 600, comm: 'claude.exe', created: T - 30_000 },
    600: { ppid: 1, comm: 'explorer.exe', created: T - 90_000 },
  };
  assert.equal(win(rows), false);
  assert.equal(win({ ...rows, 800: { ...rows[800], created: T + 2_001 } }), false, 'just over 2 s is already a reuse');
  assert.equal(win({ ...rows, 800: { ...rows[800], created: T + 2_000 } }), true, 'exactly 2 s still continues');
});

test('a reused PID that lands on Claude Code itself still refuses (fail closed, whatever the times)', () => {
  const rows = { 900: { ppid: 800, comm: 'node', created: T }, 800: { ppid: 1, comm: 'C:\\Users\\u\\bin\\claude.exe', created: T + 3_600_000 } };
  assert.equal(win(rows), true);
  const viaNode = { 900: rows[900], 800: { ppid: 1, comm: 'node.exe', args: 'node C:\\x\\@anthropic-ai\\claude-code\\cli.js', created: T + 3_600_000 } };
  assert.equal(win(viaNode), true);
});

test('a 1 s skew, equal times, normal ancestry and missing times all continue the walk and find Claude Code', () => {
  const chain = (created) => ({
    900: { ppid: 800, comm: 'node', created: created[0] },
    800: { ppid: 700, comm: 'cmd.exe', created: created[1] },
    700: { ppid: 600, comm: 'powershell.exe', created: created[2] },
    600: { ppid: 1, comm: 'claude.exe', created: created[3] },
  });
  assert.equal(win(chain([T, T + 1_000, T + 2_000, T + 3_000])), true, 'each parent 1 s later');
  assert.equal(win(chain([T, T, T, T])), true, 'equal times');
  assert.equal(win(chain([T, T - 5_000, T - 20_000, T - 60_000])), true, 'normal: parents are older');
  assert.equal(win(chain([undefined, undefined, undefined, undefined])), true, 'no times at all');
  assert.equal(win(chain([T, T - 5_000, undefined, T + 99_000_000])), true, 'a missing time on one side skips the comparison');
  assert.equal(win(chain([T, NaN, T + 99_000_000, T - 1])), true, 'non-finite is treated as missing');
  assert.equal(win(chain(['soon', T - 5_000, T - 10_000, T - 20_000])), true, 'a non-number is treated as missing');
});

test('the installer\'s own process is looked up first on Windows, and a failed own lookup changes nothing', () => {
  const calls = [];
  const rows = { 800: { ppid: 700, comm: 'cmd.exe', created: T + 60_000 }, 700: { ppid: 1, comm: 'claude.exe', created: T } };
  const spy = (pid) => { calls.push(pid); return rows[pid] ?? null; };
  assert.equal(hasClaudeCodeAncestor({ startPid: 800, ownPid: 900, platform: 'win32', lookup: spy }), true, 'no row for 900: continue as before');
  assert.deepEqual(calls, [900, 800, 700]);
  assert.equal(hasClaudeCodeAncestor({ startPid: 800, ownPid: 900, platform: 'win32', lookup: (pid) => { if (pid === 900) throw new Error('boom'); return rows[pid] ?? null; } }), true);
  calls.length = 0;
  hasClaudeCodeAncestor({ startPid: 800, ownPid: 900, platform: 'linux', lookup: spy });
  assert.deepEqual(calls, [800, 700], 'POSIX re-parents orphans: no own lookup, no time rule');
});

test('DOCUMENTED RESIDUAL: after a clock rollback a real non-Claude parent looks recycled and the walk stops (changing this is a deliberate decision)', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', created: T - 600_000 }, // the child started after the clock was set back 10 min
    800: { ppid: 700, comm: 'cmd.exe', created: T }, // its real parent started before the rollback
    700: { ppid: 1, comm: 'claude.exe', created: T - 100_000 },
  };
  assert.equal(win(rows), false);
});

test('realLookup (win32) reports CreationDate as integer epoch ms, parsed from the PowerShell JSON line', () => {
  const seen = [];
  const spawn = (cmd, args) => {
    seen.push([cmd, args]);
    return { status: 0, stdout: '{"ParentProcessId":4242,"Name":"node.exe","CommandLine":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" run.mjs","Created":1730000000123}\r\n' };
  };
  assert.deepEqual(realLookup(77, 'win32', spawn), { ppid: 4242, comm: 'node.exe', args: '"C:\\Program Files\\nodejs\\node.exe" run.mjs', created: 1730000000123 });
  const script = seen[0][1].at(-1);
  assert.match(script, /DateTimeOffset/);
  assert.match(script, /ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /ProcessId=77/);
  const row = (o) => realLookup(1, 'win32', () => ({ status: 0, stdout: JSON.stringify({ ParentProcessId: 5, Name: 'cmd.exe', CommandLine: null, ...o }) }));
  assert.equal(row({ Created: null }).created, undefined, 'null');
  assert.equal(row({}).created, undefined, 'absent');
  assert.equal(row({ Created: 'x' }).created, undefined, 'junk');
  assert.equal(row({ Created: 1.5e12 }).created, 1.5e12);
  assert.equal(row({ Created: 5 }).args, '');
  assert.equal(realLookup(1, 'win32', () => ({ status: 1, stdout: '' })), null);
  assert.equal(realLookup(1, 'win32', () => ({ status: 0, stdout: 'not json' })), null);
});

// ---- argument matching ------------------------------------------------------------------------------------------------------
const isClaude = (args) => isClaudeCodeProcess({ comm: 'node.exe', args });

test('Claude Code run by a JS runtime is detected in every script-position form, quoted or not', () => {
  for (const args of [
    'node /usr/local/bin/claude',
    'bun run /usr/local/bin/claude',
    'deno run -A /x/claude',
    'node "C:\\Program Files\\x\\claude"',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\x\\claude.exe" --resume',
    "node '/opt/my tools/claude' -p hi",
    'node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume',
  ]) assert.equal(isClaude(args), true, args);
});

test('--claude-home blanks only its own operand, and only when the command line names the installer script as a word', () => {
  for (const args of [
    'node install.mjs --claude-home C:\\x\\claude',
    'node D:\\repo\\install.mjs --claude-home C:\\x\\claude',
    '"C:\\Program Files\\nodejs\\node.exe" "D:\\repo\\install.mjs" --claude-home "C:\\x y\\claude"',
    'node install.mjs --claude-home="C:\\x y\\claude"',
    "node install.mjs --claude-home='/tmp/x y/claude'",
    'node install.mjs --claude-home=/tmp/claude --check',
    'node /repo/install.mjs --check --claude-home /tmp/claude',
  ]) assert.equal(isClaude(args), false, args);
  // not the installer: the flag is not honoured, the path is Claude-looking
  assert.equal(isClaude('node other.mjs --claude-home C:\\x\\claude'), true);
  assert.equal(isClaude('node other.mjs --claude-home=/x/claude'), true);
  // the operand only: a runtime script word that is Claude Code still counts
  assert.equal(isClaude('node install.mjs --claude-home C:\\x\\claude bun run /usr/local/bin/claude'), true);
  assert.equal(isClaude('node /usr/local/bin/claude install.mjs --claude-home /tmp/h'), true);
  assert.equal(isClaude('node /x/@anthropic-ai/claude-code/cli.js install.mjs --claude-home /tmp/h'), true);
  // the next token is blanked, not the one after it
  assert.equal(isClaude('node install.mjs --claude-home /tmp/h /usr/local/bin/claude'), true);
});

test('the installer script name or --claude-home inside a quoted token (a prompt) neither counts nor blanks the next token', () => {
  assert.equal(isClaude('node run.js -p "run install.mjs now" --claude-home /tmp/claude'), true, 'the script name only inside a prompt: the operand is evidence');
  assert.equal(isClaude('node install.mjs -p "--claude-home" /x/claude'), true, 'a quoted flag word is not followed by its operand');
  assert.equal(isClaude('node install.mjs -p "use --claude-home /x/claude" other'), true, 'a prompt mentioning the flag blanks nothing');
  assert.equal(isClaude("node run.js -p 'say install.mjs' --claude-home /tmp/claude"), true, 'single-quoted prompt too');
});

test('isClaudeCodeProcess is unchanged for the look-alikes the old pattern rejected', () => {
  for (const args of ['node scripts/test.mjs', 'node /x/claudette', 'node /x/claude-helper', 'node "C:\\x\\claudex"', 'node /x/claude/other.js']) assert.equal(isClaude(args), false, args);
});
