// Why: the installer's process-tree backstop (an agent that removes CLAUDECODE from the environment still has Claude Code
// as an ancestor). The lookup is injected, so these tests never read the real process table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeAncestorPid, hasClaudeCodeAncestor, isClaudeCodeProcess, processTable, realLookup } from '../pipeline/lib/claude-ancestry.mjs';

const table = (rows) => (pid) => rows[pid] ?? null;

test('isClaudeCodeProcess: the claude binary by any path, or a JS runtime running its cli; not the desktop app or look-alikes', () => {
  for (const comm of ['claude', '/Users/u/.local/bin/claude', 'C:\\Users\\u\\bin\\claude.exe', '/opt/homebrew/bin/claude']) assert.equal(isClaudeCodeProcess({ comm }), true, comm);
  assert.equal(isClaudeCodeProcess({ comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }), true);
  assert.equal(isClaudeCodeProcess({ comm: '/usr/local/bin/node', args: '/usr/local/bin/node /home/u/.claude/local/claude' }), true);
  assert.equal(isClaudeCodeProcess({ comm: 'bun', args: 'bun /x/claude-code/cli.js' }), true);
  // A background job's processes rename themselves (`claude bg-spare`, `claude bg-pty-host`).
  for (const comm of ['claude bg-spare', 'claude bg-pty-host', '/Users/u/.local/bin/claude bg-spare']) assert.equal(isClaudeCodeProcess({ comm }), true, comm);
  for (const info of [{ comm: 'Claude' }, { comm: 'claude-helper' }, { comm: 'claude bg' }, { comm: 'claude bg-' }, { comm: 'claude bg-spare x' }, { comm: 'claude foo' }, { comm: 'Claude bg-spare' }, { comm: 'node', args: 'node scripts/test.mjs' }, { comm: 'zsh' }, { comm: 'node' }, null, {}]) {
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

// ---- Windows: ONE process-table query per walk instead of one PowerShell per hop ---------------------------------------------
const spawnOf = (result) => { const seen = []; const spawn = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return result; }; spawn.seen = seen; return spawn; };
const jsonOut = (v) => ({ status: 0, stdout: `${JSON.stringify(v)}\r\n` });

test('processTable (win32) parses an array of rows into a pid -> info Map, with realLookup\'s per-row parsing', () => {
  const spawn = spawnOf(jsonOut([
    { ProcessId: 900, ParentProcessId: 800, Name: 'node.exe', CommandLine: 'node run.mjs', Created: 1730000000123 },
    { ProcessId: 800, ParentProcessId: 4, Name: 'cmd.exe', CommandLine: null, Created: null },
    { ProcessId: 700, ParentProcessId: 4, Name: 'a.exe', CommandLine: 'a', Created: 'x' },
    { ProcessId: 600, ParentProcessId: 4, Name: 'b.exe', CommandLine: 'b' },
    { ParentProcessId: 4, Name: 'noid.exe', CommandLine: 'c', Created: 1 },
    { ProcessId: '12', ParentProcessId: 4, Name: 'strid.exe', Created: 1 },
    { ProcessId: 1.5, ParentProcessId: 4, Name: 'frac.exe', Created: 1 },
  ]));
  const t = processTable('win32', spawn);
  assert.ok(t instanceof Map);
  assert.deepEqual(t.get(900), { ppid: 800, comm: 'node.exe', args: 'node run.mjs', created: 1730000000123 });
  assert.deepEqual(t.get(800), { ppid: 4, comm: 'cmd.exe', args: '' }, 'null CommandLine -> empty args, null Created -> no created key');
  assert.equal('created' in t.get(700), false, 'non-finite Created');
  assert.equal('created' in t.get(600), false, 'missing Created');
  assert.deepEqual([...t.keys()].sort((a, b) => a - b), [600, 700, 800, 900], 'rows without an integer ProcessId are skipped');
  // the same row parsed by realLookup is identical
  const one = { ProcessId: 900, ParentProcessId: 800, Name: 'node.exe', CommandLine: 'node run.mjs', Created: 1730000000123 };
  assert.deepEqual(realLookup(900, 'win32', spawnOf(jsonOut(one))), processTable('win32', spawnOf(jsonOut([one]))).get(900));
});

test('processTable (win32) accepts a single bare object (PowerShell unrolls one-element arrays)', () => {
  const t = processTable('win32', spawnOf(jsonOut({ ProcessId: 5, ParentProcessId: 1, Name: 'only.exe', CommandLine: 'x', Created: 7 })));
  assert.deepEqual([...t.entries()], [[5, { ppid: 1, comm: 'only.exe', args: 'x', created: 7 }]]);
});

test('processTable (win32) is one bounded PowerShell query over ALL processes', () => {
  const spawn = spawnOf(jsonOut([]));
  processTable('win32', spawn);
  assert.equal(spawn.seen.length, 1);
  const { cmd, args, opts } = spawn.seen[0];
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const script = args.at(-1);
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(script, /-Filter/, 'no per-pid filter: the whole table');
  assert.match(script, /ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /ConvertTo-Json -Compress -InputObject/);
  assert.ok(opts.maxBuffer >= 32 * 1024 * 1024, 'room for a full table with long command lines');
  assert.ok(opts.timeout > 0 && opts.timeout <= 30_000, 'bounded');
  assert.equal(opts.windowsHide, true);
});

test('processTable (win32): an enumeration error terminates the script with a non-zero exit (R1-B1)', () => {
  const spawn = spawnOf(jsonOut([]));
  processTable('win32', spawn);
  const script = spawn.seen[0].args.at(-1);
  assert.match(script, /Get-CimInstance Win32_Process -ErrorAction Stop/, 'a non-terminating enumeration error becomes terminating');
  assert.match(script, /\$ErrorActionPreference='Stop'/);
  assert.match(script, /try \{[\s\S]*\} catch \{ exit 1 \}/, 'a terminating error ends with exit code 1, not the last command\'s 0');
});

test('win32: the status-1 result of an errored table query falls back to per-hop lookups (R1-B1)', () => {
  const rows = {
    900: { ParentProcessId: 800, Name: 'node.exe', Created: T },
    800: { ParentProcessId: 700, Name: 'cmd.exe', Created: T - 1000 },
    700: { ParentProcessId: 1, Name: 'claude.exe', Created: T - 2000 },
  };
  const perPid = [];
  const spawn = (cmd, args) => {
    const m = /ProcessId=(\d+)/.exec(args.at(-1));
    if (!m) return { status: 1, stdout: '[]' };
    perPid.push(Number(m[1]));
    return rows[m[1]] ? jsonOut(rows[m[1]]) : { status: 1, stdout: '' };
  };
  assert.equal(claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', spawn }), 700);
  assert.deepEqual(perPid, [900, 800, 700]);
});

test('processTable returns null on any failure, and off win32 without spawning', () => {
  for (const r of [
    { status: 1, stdout: '[]' }, { status: 0, stdout: '' }, { status: 0, stdout: 'not json' }, { status: 0, stdout: '42' },
    { status: 0, stdout: '"str"' }, { status: 0, stdout: 'null' }, { status: 0, stdout: '[1,2]' }, { status: 0, stdout: '[null]' }, { status: null, signal: 'SIGTERM', stdout: '[]' },
    { status: 0, stdout: '[]', error: new Error('ETIMEDOUT') }, { status: 0, stdout: undefined }, { status: 0, stdout: '[]x' },
  ]) assert.equal(processTable('win32', spawnOf(r)), null, JSON.stringify(r));
  assert.equal(processTable('win32', () => { throw new Error('ENOENT'); }), null, 'a throwing spawn');
  for (const platform of ['darwin', 'linux']) {
    const spawn = spawnOf(jsonOut([]));
    assert.equal(processTable(platform, spawn), null);
    assert.equal(spawn.seen.length, 0);
  }
});

test('processTable returns null for an empty or wrong-shaped snapshot (R1-F1)', () => {
  const row = { ProcessId: 5, ParentProcessId: 1, Name: 'a.exe', CommandLine: 'x', Created: 7 };
  for (const out of [
    '{}', '[]', JSON.stringify({ value: [row], Count: 1 }), JSON.stringify([{ ...row, ProcessId: '5' }]), JSON.stringify([{ ParentProcessId: 1, Name: 'noid.exe' }]),
  ]) assert.equal(processTable('win32', spawnOf({ status: 0, stdout: out })), null, out);
});

const snap = (rows) => new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
const walkWin = (rows, extra = {}) => {
  const calls = { table: 0 };
  const pid = claudeCodeAncestorPid({
    startPid: 800, ownPid: 900, platform: 'win32',
    table: () => { calls.table++; return rows === null ? null : snap(rows); },
    ...extra,
  });
  return { pid, calls };
};

test('win32 walk with the default lookup takes ONE snapshot and does zero per-pid lookups', () => {
  const rows = {
    900: { ppid: 800, comm: 'node.exe', created: T },
    800: { ppid: 700, comm: 'cmd.exe', created: T - 1000 },
    700: { ppid: 650, comm: 'powershell.exe', created: T - 2000 },
    650: { ppid: 600, comm: 'conhost.exe', created: T - 3000 },
    600: { ppid: 1, comm: 'claude.exe', created: T - 4000 },
  };
  const { pid, calls } = walkWin(rows);
  assert.equal(pid, 600);
  assert.equal(calls.table, 1);
});

test('win32 snapshot walk: the recycled-PID rule applies to snapshot data', () => {
  const rows = {
    900: { ppid: 800, comm: 'node.exe', created: T },
    800: { ppid: 700, comm: 'cmd.exe', created: T + 2_001 },
    700: { ppid: 1, comm: 'claude.exe', created: T - 30_000 },
  };
  assert.equal(walkWin(rows).pid, null);
  assert.equal(walkWin({ ...rows, 800: { ...rows[800], created: T + 2_000 } }).pid, 700);
});

test('win32 snapshot walk: a pid absent from the snapshot ends the walk with null', () => {
  const { pid, calls } = walkWin({ 900: { ppid: 800, comm: 'node.exe', created: T }, 700: { ppid: 1, comm: 'claude.exe' } });
  assert.equal(pid, null, '800 is missing, so 700 is never reached');
  assert.equal(calls.table, 1);
});

test('win32: a failed snapshot falls back to the per-hop PowerShell lookup and gives the same answer', () => {
  const rows = {
    900: { ParentProcessId: 800, Name: 'node.exe', Created: T },
    800: { ParentProcessId: 700, Name: 'cmd.exe', Created: T - 1000 },
    700: { ParentProcessId: 1, Name: 'claude.exe', Created: T - 2000 },
  };
  const perPid = [];
  let tableQueries = 0;
  // The fake powershell: the whole-table query (no ProcessId filter) fails, each per-pid query answers from rows.
  const spawn = (cmd, args) => {
    const script = args.at(-1);
    const m = /ProcessId=(\d+)/.exec(script);
    if (!m) { tableQueries++; return { status: 1, stdout: '' }; }
    perPid.push(Number(m[1]));
    const row = rows[m[1]];
    return row ? jsonOut(row) : { status: 1, stdout: '' };
  };
  assert.equal(claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', spawn }), 700);
  assert.equal(tableQueries, 1, 'the snapshot was tried once');
  assert.deepEqual(perPid, [900, 800, 700], 'then the old per-hop path ran');
});

test('win32: a snapshot that lacks the running process is not trusted; the walk falls back to per-hop lookups (R1-F1)', () => {
  const rows = {
    900: { ParentProcessId: 800, Name: 'node.exe', Created: T },
    800: { ParentProcessId: 700, Name: 'cmd.exe', Created: T - 1000 },
    700: { ParentProcessId: 1, Name: 'claude.exe', Created: T - 2000 },
  };
  const perPid = [];
  const spawn = (cmd, args) => {
    const m = /ProcessId=(\d+)/.exec(args.at(-1));
    if (!m) throw new Error('the table query must not run: table seam is injected');
    perPid.push(Number(m[1]));
    return rows[m[1]] ? jsonOut(rows[m[1]]) : { status: 1, stdout: '' };
  };
  // a plausible-looking table that does not contain ownPid 900
  const table = () => snap({ 800: { ppid: 700, comm: 'cmd.exe', created: T - 1000 }, 700: { ppid: 1, comm: 'claude.exe', created: T - 2000 } });
  assert.equal(claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', spawn, table }), 700);
  assert.deepEqual(perPid, [900, 800, 700]);
  // an empty Map is the same
  perPid.length = 0;
  assert.equal(claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', spawn, table: () => new Map() }), 700);
  assert.deepEqual(perPid, [900, 800, 700]);
});

test('win32: with the snapshot working the default path spawns PowerShell exactly once for the whole walk', () => {
  const spawn = spawnOf(jsonOut([
    { ProcessId: 900, ParentProcessId: 800, Name: 'node.exe', CommandLine: 'node run.mjs', Created: T },
    { ProcessId: 800, ParentProcessId: 700, Name: 'cmd.exe', Created: T - 1 },
    { ProcessId: 700, ParentProcessId: 1, Name: 'claude.exe', Created: T - 2 },
  ]));
  assert.equal(claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', spawn }), 700);
  assert.equal(spawn.seen.length, 1);
});

test('win32: an injected lookup wins over table (the table is never queried); no table option keeps today\'s behaviour', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', created: T },
    800: { ppid: 700, comm: 'cmd.exe', created: T - 1 },
    700: { ppid: 1, comm: 'claude.exe', created: T - 2 },
  };
  const seen = [];
  const lookup = (pid) => { seen.push(pid); return rows[pid] ?? null; };
  let tableCalls = 0;
  const pid = claudeCodeAncestorPid({ startPid: 800, ownPid: 900, platform: 'win32', lookup, table: () => { tableCalls++; return snap({}); } });
  assert.equal(pid, 700);
  assert.equal(tableCalls, 0, 'injected lookup wins: no snapshot');
  assert.deepEqual(seen, [900, 800, 700], 'own pid, then one lookup per hop');
});

test('processTable on a real Windows host lists this process with its parent and creation time', { skip: process.platform !== 'win32' }, () => {
  const t = processTable();
  assert.ok(t instanceof Map, 'the table could be read');
  const me = t.get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.equal(me.ppid, process.ppid);
  assert.ok(Number.isFinite(me.created) && me.created <= Date.now(), `created=${me.created}`);
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
