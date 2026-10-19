// Why: a stack is kept alive by a lease that names a Claude process as { pid, birth }. "No such process" must be a
// positive finding: run() turns a signalled child into exit 1 with empty output and a spawn failure into exit 1 plus the
// error text, so ps exit 1 alone never means "dead". Every case that is not a positive "gone" is unknown (fail closed).
// ps is always a fake `run`; the real process table is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLstart, procIdentity, isAlive, findClaudeOwner } from '../pipeline/lib/stacks/identity.mjs';

const LSTART = 'Mon Oct 19 02:47:17 2026';
const BIRTH = Date.UTC(2026, 9, 19, 2, 47, 17) / 1000;
const esrch = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
const eperm = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
const alive = () => true;
const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, pid: 1, ...o });

// lstart answers by pid; a process tree answers the ppid/comm and args lookups. Every call must carry UTC / C and a timeout.
function fakePs({ lstart = {}, tree = {}, fail = {} } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    assert.equal(opts.env.TZ, 'UTC'); assert.equal(opts.env.LC_ALL, 'C');
    assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 5000, `timeout ${opts.timeoutMs}`);
    const field = args[1]; const pid = args[args.length - 1];
    if (fail[pid]) return res(fail[pid]);
    if (field === 'lstart=') return pid in lstart ? res({ stdout: `${lstart[pid]}\n` }) : res({ code: 1 });
    const row = tree[pid];
    if (!row) return res({ code: 1 });
    if (field === 'ppid=,comm=') return res({ stdout: `  ${row.ppid} ${row.comm}\n` });
    if (field === 'args=') return res({ stdout: `${row.args ?? row.comm}\n` });
    throw new Error(`unexpected ps args ${args}`);
  };
  run.calls = calls;
  return run;
}

test('parseLstart reads C-locale UTC lstart', () => {
  assert.equal(parseLstart(LSTART), BIRTH);
  assert.equal(parseLstart('Sun Oct  4 02:47:17 2026'), Date.UTC(2026, 9, 4, 2, 47, 17) / 1000, 'space-padded day');
  assert.equal(parseLstart('garbage'), null);
  assert.equal(parseLstart('Mon Foo 19 02:47:17 2026'), null);
  assert.equal(parseLstart(undefined), null);
});

test('identity: a live pid gives { pid, birth }', () => {
  const r = procIdentity(10, { run: fakePs({ lstart: { 10: LSTART } }), platform: 'darwin', kill: alive });
  assert.deepEqual(r, { ok: true, value: { pid: 10, birth: BIRTH } });
});

test('identity: dead = ps exit 1 with no output, no signal, no timeout AND kill(pid, 0) says ESRCH', () => {
  const run = fakePs();
  assert.deepEqual(procIdentity(12, { run, platform: 'darwin', kill: esrch }), { ok: true, value: null });
});

test('identity: a signalled ps (exit 1, empty, signal set) is unknown, not dead', () => {
  const run = fakePs({ fail: { 12: { code: 1, signal: 'SIGKILL' } } });
  const r = procIdentity(12, { run, platform: 'darwin', kill: esrch });
  assert.equal(r.ok, false); assert.match(r.reason, /signal/i);
});

test('identity: a timed-out ps is unknown', () => {
  const run = fakePs({ fail: { 12: { code: 124, timedOut: true } } });
  assert.equal(procIdentity(12, { run, platform: 'darwin', kill: esrch }).ok, false);
  const run1 = fakePs({ fail: { 12: { code: 1, timedOut: true } } });
  assert.equal(procIdentity(12, { run: run1, platform: 'darwin', kill: esrch }).ok, false, 'exit 1 + timedOut is still a timeout');
});

test('identity: ps could not start (ENOENT text on exit 1) is unknown', () => {
  const run = fakePs({ fail: { 12: { code: 1, stderr: 'spawn /bin/ps ENOENT' } } });
  assert.equal(procIdentity(12, { run, platform: 'darwin', kill: esrch }).ok, false);
});

test('identity: ps exit 1 with only stdout noise is unknown', () => {
  const run = fakePs({ fail: { 12: { code: 1, stdout: 'something' } } });
  assert.equal(procIdentity(12, { run, platform: 'darwin', kill: esrch }).ok, false);
});

test('identity: kill(pid, 0) failing with EPERM is unknown (the process exists but is not ours)', () => {
  const r = procIdentity(12, { run: fakePs(), platform: 'darwin', kill: eperm });
  assert.equal(r.ok, false); assert.match(r.reason, /EPERM/);
});

test('identity: ps says gone but kill(pid, 0) says alive is unknown', () => {
  const r = procIdentity(12, { run: fakePs(), platform: 'darwin', kill: alive });
  assert.equal(r.ok, false); assert.match(r.reason, /alive/i);
});

test('identity: other ps failures and unparsable output are unknown', () => {
  const run = fakePs({ fail: { 11: { code: 2, stderr: 'ps: boom' }, 13: { code: 0, stdout: 'not a date\n' }, 14: { code: 0, stdout: '' } } });
  for (const pid of [11, 13, 14]) assert.equal(procIdentity(pid, { run, platform: 'darwin', kill: esrch }).ok, false, String(pid));
});

test('identity: a bad pid never reaches ps', () => {
  const run = fakePs();
  for (const pid of [0, -4, 1.5, NaN, 'x', null, undefined]) assert.equal(procIdentity(pid, { run, platform: 'darwin', kill: esrch }).ok, false, String(pid));
  assert.equal(run.calls.length, 0);
});

test('identity: win32 is unknown and nothing runs', () => {
  const run = fakePs(); let killed = 0;
  const r = procIdentity(10, { run, platform: 'win32', kill: () => { killed++; } });
  assert.deepEqual(r, { ok: false, reason: 'windows' });
  assert.equal(run.calls.length + killed, 0);
  assert.equal(isAlive({ pid: 10, birth: BIRTH }, { run, platform: 'win32' }).ok, false);
  assert.equal(run.calls.length, 0);
});

test('identity: ps gets TZ=UTC and LC_ALL=C even when the parent runs in another time zone', () => {
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  process.env.TZ = 'America/New_York'; process.env.LC_ALL = 'fr_FR.UTF-8';
  try {
    const run = fakePs({ lstart: { 10: LSTART } }); // asserts TZ=UTC / LC_ALL=C on every call
    assert.equal(procIdentity(10, { run, platform: 'darwin', kill: alive }).value.birth, BIRTH);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].cmd, '/bin/ps');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('identity: the ps binary is injectable (the PIPELINE_PS seam is resolved by the caller)', () => {
  const run = fakePs({ lstart: { 10: LSTART } });
  procIdentity(10, { run, platform: 'darwin', kill: alive, ps: '/x/fake-ps' });
  assert.equal(run.calls[0].cmd, '/x/fake-ps');
});

test('identity deadline: each ps call gets min(3000, remaining); under 500 ms left it stops with unknown(deadline) and runs nothing', () => {
  const run = fakePs({ lstart: { 10: LSTART } });
  const now = () => 1_000_000;
  procIdentity(10, { run, platform: 'darwin', kill: alive, deadlineAt: now() + 10_000, now });
  assert.equal(run.calls[0].opts.timeoutMs, 3000);
  procIdentity(10, { run, platform: 'darwin', kill: alive, deadlineAt: now() + 1200, now });
  assert.equal(run.calls[1].opts.timeoutMs, 1200);
  const n = run.calls.length;
  const r = procIdentity(10, { run, platform: 'darwin', kill: alive, deadlineAt: now() + 499, now });
  assert.deepEqual(r, { ok: false, reason: 'deadline' });
  assert.equal(procIdentity(10, { run, platform: 'darwin', kill: alive, deadlineAt: now() - 5, now }).reason, 'deadline');
  assert.equal(run.calls.length, n);
});

test('isAlive: same birth = alive; reused pid = not alive; gone = not alive; ps failure = unknown', () => {
  const run = fakePs({ lstart: { 10: LSTART }, fail: { 11: { code: 2, stderr: 'ps: boom' } } });
  const o = { run, platform: 'darwin', kill: esrch };
  assert.equal(isAlive({ pid: 10, birth: BIRTH }, o).value, true);
  assert.equal(isAlive({ pid: 10, birth: BIRTH - 5 }, o).value, false);
  assert.deepEqual(isAlive({ pid: 12, birth: BIRTH }, o), { ok: true, value: false });
  assert.equal(isAlive({ pid: 11, birth: BIRTH }, o).ok, false);
  assert.equal(isAlive({ pid: 10, birth: null }, o).ok, false, 'an owner without a birth cannot be judged');
  assert.equal(isAlive(null, o).ok, false);
});

// ---- findClaudeOwner ----
const TREE = {
  50: { ppid: 40, comm: '/usr/local/bin/node', args: 'node hook.mjs' },
  40: { ppid: 30, comm: '/bin/zsh', args: '/bin/zsh -c x' },
  30: { ppid: 20, comm: '/Users/u/.local/bin/claude', args: 'claude' },
  20: { ppid: 1, comm: '/Users/u/.local/bin/claude', args: 'claude' },
};

test('findClaudeOwner: nearest claude ancestor, identity from lstart', () => {
  const run = fakePs({ tree: TREE, lstart: { 30: 'Mon Oct 19 02:00:00 2026' } });
  const r = findClaudeOwner({ startPid: 50, run, platform: 'darwin', kill: alive });
  assert.deepEqual(r, { ok: true, value: { pid: 30, birth: parseLstart('Mon Oct 19 02:00:00 2026') } });
  assert.ok(run.calls.every((c) => c.cmd === '/bin/ps'));
});

test('findClaudeOwner: a node host is recognised by its args; plain commands never cost an args call', () => {
  const tree = {
    9: { ppid: 8, comm: '/bin/zsh' },
    8: { ppid: 1, comm: '/usr/local/bin/node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' },
  };
  const run = fakePs({ tree, lstart: { 8: LSTART } });
  assert.equal(findClaudeOwner({ startPid: 9, run, platform: 'darwin', kill: alive }).value.pid, 8);
  const argsCalls = run.calls.filter((c) => c.args[1] === 'args=').map((c) => c.args.at(-1));
  assert.deepEqual(argsCalls, ['8'], 'args= asked only for the node process');
});

test('findClaudeOwner: the start pid itself may be claude', () => {
  const run = fakePs({ tree: TREE, lstart: { 30: LSTART } });
  assert.equal(findClaudeOwner({ startPid: 30, run, platform: 'darwin', kill: alive }).value.pid, 30);
});

test('findClaudeOwner: no claude above = unknown', () => {
  const tree = { 40: { ppid: 1, comm: '/bin/zsh' } };
  const r = findClaudeOwner({ startPid: 40, run: fakePs({ tree }), platform: 'darwin', kill: alive });
  assert.equal(r.ok, false);
});

test('findClaudeOwner: a failed ps lookup mid-walk = unknown (fail closed), whatever the reason', () => {
  const tree = { 50: { ppid: 40, comm: 'node', args: 'node x.mjs' }, 40: { ppid: 30, comm: 'zsh' } }; // 30 is unknown to ps
  assert.equal(findClaudeOwner({ startPid: 50, run: fakePs({ tree }), platform: 'darwin', kill: alive }).ok, false);
  const signalled = fakePs({ tree: TREE, fail: { 40: { code: 1, signal: 'SIGKILL' } } });
  assert.equal(findClaudeOwner({ startPid: 50, run: signalled, platform: 'darwin', kill: alive }).ok, false);
  const timeout = fakePs({ tree: TREE, fail: { 40: { code: 124, timedOut: true } } });
  assert.equal(findClaudeOwner({ startPid: 50, run: timeout, platform: 'darwin', kill: alive }).ok, false);
});

test('findClaudeOwner: the claude process exiting while we look = unknown', () => {
  const run = fakePs({ tree: TREE }); // no lstart for 30: ps says gone
  const r = findClaudeOwner({ startPid: 50, run, platform: 'darwin', kill: esrch });
  assert.equal(r.ok, false);
});

test('findClaudeOwner: cycles and chains longer than 32 hops end as unknown', () => {
  const cyc = { 5: { ppid: 6, comm: 'sh' }, 6: { ppid: 5, comm: 'sh' } };
  assert.equal(findClaudeOwner({ startPid: 5, run: fakePs({ tree: cyc }), platform: 'darwin', kill: alive }).ok, false);
  const long = {};
  for (let i = 2; i < 100; i++) long[i] = { ppid: i + 1, comm: 'sh' };
  long[40] = { ppid: 41, comm: '/Users/u/.local/bin/claude' }; // hop 38 from 2: beyond the cap
  const run = fakePs({ tree: long, lstart: { 40: LSTART } });
  const r = findClaudeOwner({ startPid: 2, run, platform: 'darwin', kill: alive });
  assert.equal(r.ok, false);
  assert.equal(run.calls.filter((c) => c.args[1] === 'ppid=,comm=').length, 32);
  long[40] = { ppid: 41, comm: 'sh' }; long[33] = { ppid: 34, comm: '/Users/u/.local/bin/claude' }; // hop 31: inside the cap
  assert.equal(findClaudeOwner({ startPid: 2, run: fakePs({ tree: long, lstart: { 33: LSTART } }), platform: 'darwin', kill: alive }).value.pid, 33);
});

test('findClaudeOwner: win32 is unknown(windows) and nothing runs', () => {
  const run = fakePs({ tree: TREE });
  const r = findClaudeOwner({ startPid: 50, run, platform: 'win32' });
  assert.deepEqual(r, { ok: false, reason: 'windows' });
  assert.equal(run.calls.length, 0);
});

test('findClaudeOwner deadline: per-call timeout is min(3000, remaining); under 500 ms left = unknown(deadline)', () => {
  let clock = 1_000_000;
  const now = () => clock;
  const run = fakePs({ tree: TREE, lstart: { 30: LSTART } });
  const timed = (cmd, args, opts) => { const r = run(cmd, args, opts); clock += 700; return r; }; // each ps call burns 700 ms
  timed.calls = run.calls;
  const r = findClaudeOwner({ startPid: 50, run: timed, platform: 'darwin', kill: alive, deadlineAt: clock + 2000, now });
  assert.deepEqual(r, { ok: false, reason: 'deadline' });
  assert.deepEqual(run.calls.map((c) => c.opts.timeoutMs), [2000, 1300, 600]);
  const fresh = fakePs({ tree: TREE, lstart: { 30: LSTART } });
  const ok1 = findClaudeOwner({ startPid: 50, run: fresh, platform: 'darwin', kill: alive, deadlineAt: 5_000_000, now: () => 1_000_000 });
  assert.equal(ok1.ok, true);
  assert.ok(fresh.calls.every((c) => c.opts.timeoutMs === 3000));
  assert.equal(findClaudeOwner({ startPid: 50, run: fakePs({ tree: TREE }), platform: 'darwin', deadlineAt: 1_000_300, now: () => 1_000_000 }).reason, 'deadline');
});
