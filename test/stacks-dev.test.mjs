// Why: a session's dev server may be stopped when the session ends, but ONLY that session's own server. The binder decides
// "own" by process ancestry at bind time; a server started from a terminal, a replacement that appeared after the real launch
// failed, a daemon re-parented to init, a reused pid, or a listener two sessions could both claim must never be bound or
// signalled. These tests drive dev.mjs through an injected process world (fake ps / lsof / kill) and, for the hook entry, a
// real spawn with fake ps / lsof binaries and a throwaway state root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listeners, bindDev, devSessionEnd, devRows, devRecords, runDevBind, readRecentEvents, resolveDevBins, psLookup, TERM_WAIT_MS } from '../pipeline/lib/stacks/dev.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { parseLstart } from '../pipeline/lib/stacks/identity.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'pipeline', 'hooks', 'stack-dev-bind.mjs');
const FAKE_PS = join(here, 'fixtures', 'fake-ps-bin.mjs');
const FAKE_LSOF = join(here, 'fixtures', 'fake-lsof-bin.mjs');

// ---- time ----
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0) / 1000; // epoch seconds: the launch (tPre)
const iso = (s) => new Date(s * 1000).toISOString();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const lstart = (s) => {
  const d = new Date(s * 1000);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};

// ---- a throwaway disk world ----
const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-dev-')));
let counter = 0;
function dirs() {
  const dir = join(base, `case-${++counter}`);
  const wt = join(dir, 'wt', 'project');
  mkdirSync(join(wt, 'src'), { recursive: true });
  const root = join(dir, 'state');
  mkdirSync(root, { recursive: true });
  return { dir, wt, root, files: stackFiles(root) };
}

// ---- an injected process world ----
const OWNER = { pid: 100, birth: T0 - 3600 };
const res = (code, stdout = '', stderr = '') => ({ code, stdout, stderr, timedOut: false, signal: null, pid: 1 });
const gone = (pid) => Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });

// procs: { pid: { ppid, birth, cwd?, comm? } }; listeners: { port: [pid] }. A pid missing from procs is dead.
function world({ procs = {}, listen = {}, onTerm } = {}) {
  const w = { procs: { ...procs }, listen: { ...listen }, runs: [], kills: [], probes: [], sleeps: [] };
  w.run = (cmd, args) => {
    w.runs.push([cmd, ...args]);
    if (cmd === 'PS') {
      const pid = Number(args[args.indexOf('-p') + 1]);
      const field = args[args.indexOf('-o') + 1];
      const p = w.procs[pid];
      if (!p) return res(1);
      if (field === 'lstart=') return res(0, `${lstart(p.birth)}\n`);
      if (field === 'ppid=,comm=') return res(0, `${p.ppid} ${p.comm ?? 'node'}\n`);
      return res(2, '', 'fake ps: unexpected field');
    }
    if (cmd === 'LSOF') {
      const inet = args.find((a) => a.startsWith('-iTCP:'));
      if (inet) {
        const pids = w.listen[inet.slice(6)] ?? [];
        return pids.length ? res(0, pids.map((p) => `p${p}\nn*:${inet.slice(6)}\n`).join('')) : res(1);
      }
      const pid = Number(args[args.indexOf('-p') + 1]);
      const p = w.procs[pid];
      return p?.cwd ? res(0, `p${pid}\nfcwd\nn${p.cwd}\n`) : res(1);
    }
    return res(127, '', `unexpected command ${cmd}`);
  };
  w.probeKill = (pid, sig) => {
    w.probes.push([pid, sig]);
    if (!w.procs[pid]) throw gone(pid);
    return true;
  };
  w.kill = (pid, sig) => {
    w.kills.push([pid, sig]);
    if (!w.procs[pid]) throw gone(pid);
    if (sig === 'SIGTERM' && onTerm) onTerm(w, pid);
    return true;
  };
  w.sleep = async (ms) => {
    w.sleeps.push(ms);
  };
  w.bins = { lsof: 'LSOF', ps: 'PS' };
  return w;
}

// The standard picture: owner 100 (Claude) -> sh 200 -> listener 300 on :3000 born 4 s after the launch, cwd in the worktree.
function std(d, { extra = {} } = {}) {
  return world({
    procs: {
      100: { ppid: 1, birth: OWNER.birth, comm: 'claude' },
      200: { ppid: 100, birth: T0 + 1, comm: 'sh' },
      300: { ppid: 200, birth: T0 + 4, cwd: d.wt },
      ...extra,
    },
    listen: { 3000: [300] },
  });
}

const record = (d, over = {}) => ({
  t: iso(T0), kind: 'dev', session_id: 's1', tool_use_id: 'tu1', owner: OWNER, cwd: d.wt, worktree: d.wt, tool: 'Bash',
  port: 3000, tPre: iso(T0), tPost: iso(T0 + 2), ...over,
});
const NOW = (T0 + 30) * 1000;
const bindOpts = (w, over = {}) => ({ owner: OWNER, run: w.run, ...w.bins, kill: w.probeKill, now: () => NOW, others: [], ...over });

// ---------------------------------------------------------------- listeners

test('listeners: pid, birth (UTC) and cwd of the LISTEN socket owner; a dead pid is left out', () => {
  const d = dirs();
  const w = std(d);
  w.listen[3000] = [300, 301];
  const r = listeners(3000, { run: w.run, ...w.bins, kill: w.probeKill });
  assert.deepEqual(r, ok([{ pid: 300, birth: T0 + 4, cwd: d.wt }]));
});

test('listeners: lsof says nothing found (clean silent exit 1) => ok([]); every kind of probe failure => unknown, never []', () => {
  const d = dirs();
  const empty = std(d);
  empty.listen = {};
  assert.deepEqual(listeners(3000, { run: empty.run, ...empty.bins, kill: empty.probeKill }), ok([]));
  const failures = {
    timeout: { code: 124, stdout: '', stderr: '', timedOut: true, signal: null },
    signal: { code: 1, stdout: '', stderr: '', timedOut: false, signal: 'SIGKILL' },
    enoent: { code: 1, stdout: '', stderr: 'spawn LSOF ENOENT', timedOut: false, signal: null },
    exit2: { code: 2, stdout: '', stderr: 'lsof: bad option', timedOut: false, signal: null },
    exit1WithOutput: { code: 1, stdout: 'p300\nn*:3000\n', stderr: '', timedOut: false, signal: null },
    garbage: { code: 0, stdout: 'hello', stderr: '', timedOut: false, signal: null },
  };
  for (const [name, r] of Object.entries(failures)) {
    const w = std(d);
    const run = (cmd, args) => (cmd === 'LSOF' && args.some((a) => a.startsWith('-iTCP:')) ? r : w.run(cmd, args));
    const got = listeners(3000, { run, ...w.bins, kill: w.probeKill });
    assert.equal(got.ok, false, name);
  }
});

test('listeners: an alive listener whose cwd lsof cannot show => unknown; one that vanished meanwhile is dropped', () => {
  const d = dirs();
  const hidden = world({ procs: { 300: { ppid: 1, birth: T0 + 4 } }, listen: { 3000: [300] } }); // alive, no cwd
  assert.equal(listeners(3000, { run: hidden.run, ...hidden.bins, kill: hidden.probeKill }).ok, false);
  const w = std(d);
  const run = (cmd, args) => {
    if (cmd === 'LSOF' && args.includes('-p')) delete w.procs[300]; // exits between the two lsof calls
    return w.run(cmd, args);
  };
  assert.deepEqual(listeners(3000, { run, ...w.bins, kill: w.probeKill }), ok([]));
});

test('listeners: win32 => unknown and no subprocess', () => {
  const run = () => assert.fail('no subprocess on win32');
  assert.equal(listeners(3000, { run, platform: 'win32' }).ok, false);
});

// ---------------------------------------------------------------- bindDev (Codex F3 cases)

test('bindDev: a listener descended from the owner, born in the window, cwd inside the worktree => bound', () => {
  const d = dirs();
  const w = std(d);
  assert.deepEqual(bindDev(record(d), bindOpts(w)), { bound: { listenerPid: 300, listenerBirth: T0 + 4, cwd: d.wt } });
});

test('F3 terminal-started listener (ancestry without the owner, birth in the window) => unbound', () => {
  const d = dirs();
  const w = std(d, { extra: { 200: { ppid: 700, birth: T0 + 1 }, 700: { ppid: 600, birth: T0 - 900, comm: 'zsh' }, 600: { ppid: 1, birth: T0 - 1000, comm: 'Terminal' } } });
  const r = bindDev(record(d), bindOpts(w));
  assert.equal(r.bound, null);
  assert.match(r.reason, /not descended from the session/);
});

test('F3 replacement listener appears before the first bind (the real launch failed) => unbound', () => {
  const d = dirs();
  // 300 (the session's launch) crashed on startup; 400, started by hand from a terminal 20 s later, now holds the port.
  const w = world({
    procs: {
      100: { ppid: 1, birth: OWNER.birth, comm: 'claude' },
      500: { ppid: 1, birth: T0 - 500, comm: 'zsh' },
      400: { ppid: 500, birth: T0 + 20, cwd: d.wt },
    },
    listen: { 3000: [400] },
  });
  const r = bindDev(record(d), bindOpts(w));
  assert.equal(r.bound, null);
  assert.match(r.reason, /pid 400: not descended/);
});

test('F3 detached listener (re-parented to init, ppid 1) => unbound', () => {
  const d = dirs();
  const w = std(d, { extra: { 300: { ppid: 1, birth: T0 + 4, cwd: d.wt } } });
  const r = bindDev(record(d), bindOpts(w));
  assert.equal(r.bound, null);
  assert.match(r.reason, /init/);
});

test('bindDev: the owner pid in the chain must be the same process (an ancestor with a different birth is a stranger)', () => {
  const d = dirs();
  const w = std(d, { extra: { 100: { ppid: 1, birth: OWNER.birth + 500, comm: 'claude' } } });
  const r = bindDev(record(d), bindOpts(w));
  assert.equal(r.bound, null);
  assert.match(r.reason, /birth differs/);
});

test('bindDev: birth window is [tPre - 2 s, tPost + 60 s], edges included', () => {
  const d = dirs();
  const born = (s) => bindDev(record(d), bindOpts(std(d, { extra: { 300: { ppid: 200, birth: s, cwd: d.wt } } })));
  assert.ok(born(T0 - 2).bound, 'tPre - 2 s');
  assert.equal(born(T0 - 3).bound, null, 'tPre - 3 s (an older server that was already running)');
  assert.ok(born(T0 + 62).bound, 'tPost + 60 s');
  assert.equal(born(T0 + 63).bound, null, 'tPost + 61 s');
});

test('bindDev: cwd must be inside the recorded worktree (a subdirectory is fine, a sibling is not)', () => {
  const d = dirs();
  const inside = std(d, { extra: { 300: { ppid: 200, birth: T0 + 4, cwd: join(d.wt, 'src') } } });
  assert.ok(bindDev(record(d), bindOpts(inside)).bound);
  const sibling = std(d, { extra: { 300: { ppid: 200, birth: T0 + 4, cwd: `${d.wt}-other` } } });
  const r = bindDev(record(d), bindOpts(sibling));
  assert.equal(r.bound, null);
  assert.match(r.reason, /outside the recorded worktree/);
});

test('bindDev: a record whose only roots are too broad (/, a home directory) binds nothing', () => {
  const d = dirs();
  const w = std(d);
  for (const root of ['/', '/Users/someone', 'none']) {
    const r = bindDev(record(d, { worktree: root, cwd: root }), bindOpts(w));
    assert.equal(r.bound, null, root);
    assert.match(r.reason, /no usable worktree or cwd/);
  }
});

test('bindDev: another session\'s dev record for the port whose window covers the birth => unbound (ambiguous)', () => {
  const d = dirs();
  const w = std(d);
  const other = record(d, { session_id: 's2', tool_use_id: 'tu9', owner: { pid: 999, birth: 5 }, t: iso(T0 + 3), tPre: iso(T0 + 3), tPost: iso(T0 + 5) });
  const r = bindDev(record(d), bindOpts(w, { others: [other] }));
  assert.equal(r.bound, null);
  assert.match(r.reason, /another session's dev record/);
  // a record for another port, or one whose window ended well before the birth, does not interfere
  assert.ok(bindDev(record(d), bindOpts(w, { others: [{ ...other, port: 3001 }] })).bound);
  const early = { ...other, t: iso(T0 - 600), tPre: iso(T0 - 600), tPost: iso(T0 - 590) };
  assert.ok(bindDev(record(d), bindOpts(w, { others: [early] })).bound);
  // the same owner's own other record is not "another session"
  assert.ok(bindDev(record(d), bindOpts(w, { others: [{ ...other, owner: OWNER, session_id: 's1' }] })).bound);
});

test('bindDev: one listener binds once (already bound to another record => unbound; to this record => already)', () => {
  const d = dirs();
  const w = std(d);
  const taken = { kind: 'dev-bind', t: iso(T0 + 5), session_id: 's2', owner: { pid: 999, birth: 5 }, port: 3000, devT: iso(T0 - 100), listenerPid: 300, listenerBirth: T0 + 4 };
  const r = bindDev(record(d), bindOpts(w, { others: [taken] }));
  assert.equal(r.bound, null);
  assert.match(r.reason, /already bound/);
  const mine = { ...taken, session_id: 's1', owner: OWNER, devT: iso(T0) };
  assert.equal(bindDev(record(d), bindOpts(w, { others: [mine] })).bound.already, true);
});

test('bindDev: two qualifying listeners => unbound (ambiguous); nothing listening => unbound; probes unknown => unbound', () => {
  const d = dirs();
  const two = std(d, { extra: { 301: { ppid: 200, birth: T0 + 5, cwd: d.wt } } });
  two.listen[3000] = [300, 301];
  assert.match(bindDev(record(d), bindOpts(two)).reason, /ambiguous/);
  const none = std(d);
  none.listen = {};
  assert.match(bindDev(record(d), bindOpts(none)).reason, /nothing listens/);
  const w = std(d);
  const failing = (cmd, args) => (cmd === 'LSOF' ? { code: 124, stdout: '', stderr: '', timedOut: true, signal: null } : w.run(cmd, args));
  assert.match(bindDev(record(d), bindOpts(w, { run: failing })).reason, /listeners unknown/);
  const badLookup = bindDev(record(d), bindOpts(w, { lookup: () => unknown('ps failed') }));
  assert.equal(badLookup.bound, null);
  assert.match(badLookup.reason, /ancestry unknown/);
});

test('bindDev: an injected lookup is used (ancestry walked through it), and asked for the birth only at the owner hop', () => {
  const d = dirs();
  const w = std(d);
  const table = { 300: { ppid: 200 }, 200: { ppid: 100 }, 100: { ppid: 1, birth: OWNER.birth } };
  const asked = [];
  const lookup = (pid, o) => {
    asked.push([pid, o?.withBirth]);
    return ok(table[pid]);
  };
  assert.ok(bindDev(record(d), bindOpts(w, { lookup })).bound);
  assert.deepEqual(asked, [[300, false], [200, false], [100, true]]);
});

test('bindDev: win32 => unbound with no subprocess', () => {
  const d = dirs();
  const run = () => assert.fail('no subprocess on win32');
  assert.equal(bindDev(record(d), { owner: OWNER, run, platform: 'win32' }).bound, null);
});

// ---------------------------------------------------------------- devSessionEnd

function endWorld(d, { procsExtra = {}, onTerm } = {}) {
  // the owner is gone (not in procs); listener 300 is alive in the worktree
  const w = world({ procs: { 300: { ppid: 1, birth: T0 + 4, cwd: d.wt }, ...procsExtra }, listen: { 3000: [300] }, onTerm });
  writeFileSync(d.files.config, '{}\n');
  writeFileSync(d.files.mode, JSON.stringify({ devServers: 'apply' }));
  return w;
}
const bindEv = (d, over = {}) => ({
  t: iso(T0 + 5), kind: 'dev-bind', session_id: 's1', owner: OWNER, port: 3000, devT: iso(T0), listenerPid: 300, listenerBirth: T0 + 4,
  cwd: d.wt, worktree: d.wt, recordCwd: d.wt, ...over,
});
const endOpts = (d, w, over = {}) => ({
  run: w.run, ...w.bins, kill: w.kill, probeKill: w.probeKill, sleep: w.sleep, root: d.root, home: d.dir, mode: 'apply', now: () => NOW,
  ownerExitedAt: NOW - 7000, ...over,
});

test('session end, apply: exactly ONE SIGTERM to the bound listener, a 10 s re-check, no SIGKILL', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { onTerm: (world, pid) => delete world.procs[pid] });
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.deepEqual(w.kills, [[300, 'SIGTERM']]);
  assert.deepEqual(w.sleeps, [TERM_WAIT_MS]);
  assert.equal(TERM_WAIT_MS, 10000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'stopped');
  assert.equal(rows[0].port, 3000);
  assert.equal(rows[0].aliveAfterExitMs, 7000);
});

test('session end, apply: still alive after 10 s => reported, still exactly one SIGTERM and never a SIGKILL', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d); // ignores SIGTERM
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.deepEqual(w.kills, [[300, 'SIGTERM']]);
  assert.ok(!w.kills.some(([, sig]) => /KILL/.test(String(sig))));
  assert.equal(rows[0].action, 'term-ignored');
  assert.equal(rows[0].alive, true);
  assert.match(rows[0].reasons.join(' '), /never SIGKILL/);
});

test('session end, report mode: bound + alive => would-stop, no signal, aliveAfterExitMs measured', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d);
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { mode: 'report' }));
  assert.deepEqual(w.kills, []);
  assert.equal(rows[0].action, 'would-stop');
  assert.equal(rows[0].aliveAfterExitMs, 7000);
  assert.equal(rows[0].alive, true);
  // the caller said apply but mode.json says report: kept, still no signal
  writeFileSync(d.files.mode, JSON.stringify({ devServers: 'report' }));
  const again = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.equal(again[0].action, 'kept');
  assert.deepEqual(w.kills, []);
});

test('F3 pid reuse at session end (same pid, different birth) => not signalled', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { procsExtra: { 300: { ppid: 1, birth: T0 + 99999, cwd: d.wt } } });
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.deepEqual(w.kills, []);
  assert.equal(rows[0].action, 'kept');
  assert.match(rows[0].reasons.join(' '), /another process/);
  assert.equal(rows[0].alive, false);
});

test('session end: listener already gone => already-gone, no signal', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d);
  delete w.procs[300];
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.deepEqual(w.kills, []);
  assert.equal(rows[0].action, 'already-gone');
});

test('session end: the listener\'s cwd left the recorded worktree => kept', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { procsExtra: { 300: { ppid: 1, birth: T0 + 4, cwd: join(d.dir, 'elsewhere') } } });
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.deepEqual(w.kills, []);
  assert.match(rows[0].reasons.join(' '), /left the recorded worktree/);
});

test('session end: only binds of THIS owner are considered; duplicate bind lines signal once', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { onTerm: (world, pid) => delete world.procs[pid] });
  w.procs[301] = { ppid: 1, birth: T0 + 9, cwd: d.wt };
  const stranger = bindEv(d, { owner: { pid: 555, birth: 5 }, listenerPid: 301, listenerBirth: T0 + 9 });
  const rows = await devSessionEnd(OWNER, [bindEv(d), bindEv(d, { t: iso(T0 + 6) }), stranger], endOpts(d, w));
  assert.deepEqual(w.kills, [[300, 'SIGTERM']]);
  assert.equal(rows.length, 1);
  assert.deepEqual(await devSessionEnd({ pid: 7, birth: 7 }, [bindEv(d)], endOpts(d, w)), []);
});

test('session end: the owner must be gone (still running or unknown => kept, no signal)', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { procsExtra: { 100: { ppid: 1, birth: OWNER.birth, comm: 'claude' } } });
  const alive = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w));
  assert.equal(alive[0].action, 'kept');
  assert.match(alive[0].reasons.join(' '), /still running/);
  const down = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { run: () => ({ code: 124, stdout: '', stderr: '', timedOut: true, signal: null }) }));
  assert.equal(down[0].action, 'kept');
  assert.deepEqual(w.kills, []);
});

test('session end R2-6: pause / config deleted / mode flipped to report between assessment and the signal => no kill', posixOnly, async () => {
  const flips = {
    'pause created': (d) => writeFileSync(d.files.pause, ''),
    'config deleted': (d) => rmSync(d.files.config),
    'mode flipped to report': (d) => writeFileSync(d.files.mode, JSON.stringify({ devServers: 'report' })),
  };
  for (const [name, flip] of Object.entries(flips)) {
    const d = dirs();
    const w = endWorld(d);
    const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { beforeMutate: () => flip(d) }));
    assert.deepEqual(w.kills, [], name);
    assert.equal(rows[0].action, 'kept', name);
  }
  // reasons name the gate
  const d = dirs();
  const w = endWorld(d);
  const paused = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { beforeMutate: () => writeFileSync(d.files.pause, '') }));
  assert.deepEqual(paused[0].reasons, ['paused']);
  rmSync(d.files.pause);
  const noCfg = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { beforeMutate: () => rmSync(d.files.config) }));
  assert.deepEqual(noCfg[0].reasons, ['not configured']);
});

test('session end: the signal is sent under the dev lock (dev/<port>), and a busy lock skips the server', posixOnly, async () => {
  const d = dirs();
  const w = endWorld(d, { onTerm: (world, pid) => delete world.procs[pid] });
  const held = [];
  const acquire = async (name, o) => {
    held.push([name, o.dir]);
    return { name, dir: o.dir };
  };
  const release = (lock) => held.push(['released', lock.name]);
  let during = null;
  const kill = (pid, sig) => {
    during = held.slice();
    return w.kill(pid, sig);
  };
  await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { acquire, release, kill }));
  assert.deepEqual(during, [['3000', lockDirs(d.root).dev]]);
  assert.deepEqual(held.at(-1), ['released', '3000']);
  const busy = endWorld(d);
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, busy, { acquire: async () => { throw new Error('lock busy'); } }));
  assert.deepEqual(busy.kills, []);
  assert.match(rows[0].reasons.join(' '), /busy/);
});

test('session end: no state root / win32 => kept / nothing, no signal', async () => {
  const d = dirs();
  const w = endWorld(d);
  const rows = await devSessionEnd(OWNER, [bindEv(d)], endOpts(d, w, { root: undefined }));
  assert.equal(rows[0].action, 'kept');
  assert.deepEqual(w.kills, []);
  const noIo = () => assert.fail('no subprocess on win32');
  assert.deepEqual(await devSessionEnd(OWNER, [bindEv(d)], { platform: 'win32', run: noIo, kill: noIo }), []);
});

// ---------------------------------------------------------------- devRows

test('devRows: owned / orphan candidate / unknown; report only', () => {
  const d = dirs();
  const w = world({
    procs: {
      300: { ppid: 1, birth: T0 + 4, cwd: d.wt },
      301: { ppid: 1, birth: T0 + 5, cwd: join(d.dir, 'wt', 'unbound') },
      302: { ppid: 1, birth: T0 + 6, cwd: d.wt },
    },
    listen: { 3000: [300], 3001: [301], 3002: [302] },
  });
  const events = [
    bindEv(d),
    bindEv(d, { port: 3002, listenerPid: 302, listenerBirth: T0 + 6, owner: { pid: 8, birth: 8 } }),
  ];
  const alive = new Map([[`${OWNER.pid}:${OWNER.birth}`, true], ['8:8', false]]);
  const rows = devRows({
    ports: [3000, 3001, 3002, 3003], events, run: w.run, ...w.bins, kill: w.probeKill, now: () => NOW,
    isAlive: (o) => ok(alive.get(`${o.pid}:${o.birth}`)),
  });
  const by = Object.fromEntries(rows.map((r) => [r.port, r]));
  assert.equal(by[3000].verdict, 'owned');
  assert.equal(by[3000].boundOwnerAlive, true);
  assert.equal(by[3000].pid, 300);
  assert.equal(by[3000].cwd, d.wt);
  assert.equal(by[3000].worktree, d.wt);
  assert.equal(by[3000].uptimeS, 26);
  assert.equal(by[3002].verdict, 'orphan candidate');
  assert.equal(by[3002].boundOwnerAlive, false);
  assert.equal(by[3001].verdict, 'unknown');
  assert.equal(by[3001].boundOwnerAlive, null);
  assert.equal(by[3003], undefined, 'no listener => no row');
  assert.ok(w.runs.every(([cmd]) => cmd === 'LSOF' || cmd === 'PS'), 'only lsof / ps are run');
  assert.deepEqual(w.kills, []);
});

test('devRows: a failed probe is a row with verdict unknown (not "no listener"); unknown owner liveness => unknown; PR state is carried', () => {
  const d = dirs();
  const w = std(d);
  const failing = () => ({ code: 124, stdout: '', stderr: '', timedOut: true, signal: null });
  const bad = devRows({ ports: [3000], events: [], run: failing, ...w.bins, now: () => NOW });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].verdict, 'unknown');
  const events = [bindEv(d)];
  const unk = devRows({ ports: [3000], events, run: w.run, ...w.bins, kill: w.probeKill, now: () => NOW, isAlive: () => unknown('ps timed out') });
  assert.equal(unk[0].verdict, 'unknown');
  assert.equal(unk[0].boundOwnerAlive, null);
  const pr = { state: 'MERGED', headMatches: true, eligible: true };
  const withPr = devRows({
    ports: [3000], events, run: w.run, ...w.bins, kill: w.probeKill, now: () => NOW, isAlive: () => ok(false),
    prStates: (wts) => ok(new Map(wts.map((x) => [x.path, pr]))),
  });
  assert.equal(withPr[0].verdict, 'orphan candidate');
  assert.deepEqual(withPr[0].pr, pr);
});

// ---------------------------------------------------------------- records, tail reader, seams

test('devRecords joins tPost by session + tool_use_id and flags the bound ones', () => {
  const d = dirs();
  const dev = { ...record(d), tPost: undefined };
  delete dev.tPost;
  const post = { t: iso(T0 + 2), kind: 'dev-post', session_id: 's1', tool_use_id: 'tu1', owner: OWNER, tPost: iso(T0 + 2) };
  const otherSessionPost = { ...post, session_id: 's2', tPost: iso(T0 + 99) };
  const [r] = devRecords([dev, otherSessionPost, post]);
  assert.equal(r.tPost, iso(T0 + 2));
  assert.equal(r.bound, null);
  const [b] = devRecords([dev, post, bindEv(d)]);
  assert.equal(b.bound.listenerPid, 300);
});

test('readRecentEvents: whole small file; damaged lines skipped; missing file => []; a tail that does not reach back => unknown', () => {
  const d = dirs();
  const f = join(d.dir, 'ledger.jsonl');
  assert.deepEqual(readRecentEvents(f), ok([]));
  writeFileSync(f, `${JSON.stringify({ t: iso(T0), kind: 'use' })}\nnot json\n${JSON.stringify({ t: iso(T0 + 1), kind: 'dev' })}\n`);
  assert.deepEqual(readRecentEvents(f, { nowMs: NOW }).value.map((e) => e.kind), ['use', 'dev']);
  // a big file: the tail reaches back past the lookback => ok; a tail that is all recent => unknown
  const old = JSON.stringify({ t: iso(T0 - 7200), kind: 'use', pad: 'x'.repeat(200) });
  const recent = JSON.stringify({ t: iso(T0), kind: 'use', pad: 'x'.repeat(200) });
  writeFileSync(f, `${old}\n${old}\n${old}\n${recent}\n`);
  assert.equal(readRecentEvents(f, { nowMs: NOW, maxBytes: 700 }).ok, true, 'tail reaches an old line');
  writeFileSync(f, `${old}\n${recent}\n${recent}\n${recent}\n${recent}\n`);
  assert.equal(readRecentEvents(f, { nowMs: NOW, maxBytes: 700 }).ok, false, 'tail is all recent: older records might hide');
});

test('resolveDevBins: PIPELINE_LSOF / PIPELINE_PS are honoured only for an isolated run (custom root + ONLY); otherwise the system paths', () => {
  const d = dirs();
  const env = { PIPELINE_LSOF: '/fake/lsof', PIPELINE_PS: '/fake/ps' };
  const isolated = resolveDevBins({ env: { ...env, PIPELINE_STACKS_HOME: d.root, PIPELINE_STACKS_ONLY: 'x' }, home: d.dir });
  assert.deepEqual(isolated, { lsof: '/fake/lsof', ps: '/fake/ps' });
  const noOnly = resolveDevBins({ env: { ...env, PIPELINE_STACKS_HOME: d.root }, home: d.dir });
  assert.deepEqual(noOnly, { lsof: '/usr/sbin/lsof', ps: '/bin/ps' });
  const defaultRoot = join(d.dir, '.claude', 'pipeline-state', 'stacks');
  const dflt = resolveDevBins({ env: { ...env, PIPELINE_STACKS_HOME: defaultRoot, PIPELINE_STACKS_ONLY: 'x' }, home: d.dir });
  assert.deepEqual(dflt, { lsof: '/usr/sbin/lsof', ps: '/bin/ps' });
});

test('psLookup: ppid via ps; birth only on request; a dead pid is unknown', () => {
  const d = dirs();
  const w = std(d);
  const look = psLookup({ run: w.run, ps: 'PS', kill: w.probeKill });
  assert.deepEqual(look(300), ok({ ppid: 200 }));
  assert.deepEqual(look(100, { withBirth: true }), ok({ ppid: 1, birth: OWNER.birth }));
  assert.equal(look(9999).ok, false);
});

// ---------------------------------------------------------------- the hook flow (runDevBind)

function hookWorld(over = {}) {
  const d = dirs();
  const w = std(d);
  const input = { tool_name: 'Bash', tool_input: { command: 'npm run dev' }, session_id: 's1', tool_use_id: 'tu1', cwd: d.wt, hook_event_name: 'PostToolUse' };
  // the PreToolUse hook's record, written 10 s before "now"
  const dev = { ...record(d, { t: iso(T0 + 20), tPre: iso(T0 + 20) }) };
  delete dev.tPost;
  dev.owner = OWNER;
  return { d, w, input, dev, ...over };
}
const hookDeps = (h, over = {}) => ({
  env: {}, platform: 'linux', home: h.d.dir, root: h.d.root, files: h.d.files, now: () => (T0 + 30) * 1000, run: h.w.run, bins: h.w.bins,
  log: () => {}, ...over,
});
const ledgerLines = (h) => (existsSync(h.d.files.ledger) ? readFileSync(h.d.files.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const seedLedger = (h, events) => writeFileSync(h.d.files.ledger, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
// births relative to the hook scenario: the server of a record launched at T0 + 20 is born at T0 + 24
const bornAt = (h, s) => {
  h.w.procs[300] = { ppid: 200, birth: s, cwd: h.d.wt };
};

test('hook flow: appends dev-post for this tool_use_id, then dev-bind for the session\'s unbound record', async () => {
  const h = hookWorld();
  bornAt(h, T0 + 24);
  seedLedger(h, [h.dev]);
  const r = await runDevBind(h.input, hookDeps(h));
  assert.equal(r.exit, 0);
  const lines = ledgerLines(h);
  assert.deepEqual(lines.map((e) => e.kind), ['dev', 'dev-post', 'dev-bind']);
  assert.equal(lines[1].tool_use_id, 'tu1');
  assert.equal(lines[1].tPost, iso(T0 + 30));
  assert.deepEqual(lines[2].owner, OWNER);
  assert.deepEqual([lines[2].port, lines[2].listenerPid, lines[2].listenerBirth, lines[2].devT], [3000, 300, T0 + 24, h.dev.t]);
  assert.equal(lines[2].worktree, h.d.wt);
  // a second call does not bind the same record again
  await runDevBind({ ...h.input, tool_use_id: 'tu2' }, hookDeps(h));
  assert.equal(ledgerLines(h).filter((e) => e.kind === 'dev-bind').length, 1);
});

test('hook flow: a terminal-started listener gets the dev-post but no dev-bind', async () => {
  const h = hookWorld();
  bornAt(h, T0 + 24);
  h.w.procs[300].ppid = 800;
  h.w.procs[800] = { ppid: 1, birth: T0 - 5000, comm: 'zsh' };
  seedLedger(h, [h.dev]);
  const r = await runDevBind(h.input, hookDeps(h));
  assert.equal(r.exit, 0);
  assert.deepEqual(ledgerLines(h).map((e) => e.kind), ['dev', 'dev-post']);
  assert.match(r.unbound[0].reason, /not descended/);
});

test('hook flow: records younger than 3 s or older than 10 min are not bound; other sessions\' records are not touched', async () => {
  for (const [name, tPre, session, expect] of [
    ['2 s old', T0 + 28, 's1', 0],
    ['3 s old', T0 + 27, 's1', 1],
    ['10 min old', T0 + 30 - 600, 's1', 1],
    ['10 min + 1 s old', T0 + 30 - 601, 's1', 0],
    ['another session', T0 + 20, 's2', 0],
  ]) {
    const h = hookWorld();
    h.dev = { ...h.dev, t: iso(tPre), tPre: iso(tPre), session_id: session };
    bornAt(h, tPre + 4);
    seedLedger(h, [h.dev]);
    await runDevBind(h.input, hookDeps(h));
    assert.equal(ledgerLines(h).filter((e) => e.kind === 'dev-bind').length, expect, name);
  }
});

test('hook flow: non-Bash, no session, no dev record => nothing appended', async () => {
  const h = hookWorld();
  bornAt(h, T0 + 24);
  seedLedger(h, [h.dev]);
  await runDevBind({ ...h.input, tool_name: 'Read' }, hookDeps(h));
  await runDevBind({ ...h.input, session_id: undefined }, hookDeps(h));
  assert.equal(ledgerLines(h).length, 1);
  const none = hookWorld();
  seedLedger(none, [{ t: iso(T0), kind: 'use', project: 'x', owner: OWNER }]);
  await runDevBind(none.input, hookDeps(none));
  assert.equal(ledgerLines(none).length, 1);
  assert.equal(ledgerLines(none)[0].kind, 'use');
});

test('hook flow NEVER blocks: append failure, ledger read failure, a throwing run and a thrown error all return exit 0', async () => {
  const lines = [];
  const h = hookWorld();
  bornAt(h, T0 + 24);
  seedLedger(h, [h.dev]);
  const a = await runDevBind(h.input, hookDeps(h, { appendEvent: async () => unknown('ledger lock unavailable'), log: (l) => lines.push(l) }));
  assert.equal(a.exit, 0);
  const b = await runDevBind(h.input, hookDeps(h, { readRecent: () => unknown('ledger unreadable'), log: (l) => lines.push(l) }));
  assert.equal(b.exit, 0);
  const c = await runDevBind(h.input, hookDeps(h, { run: () => { throw new Error('spawn boom'); }, log: (l) => lines.push(l) }));
  assert.equal(c.exit, 0);
  const e = await runDevBind(h.input, hookDeps(h, { appendEvent: async () => { throw new Error('append boom'); }, log: (l) => lines.push(l) }));
  assert.equal(e.exit, 0);
  assert.ok(lines.some((l) => /failed|skipped/.test(l)), 'failures leave a log line');
  const g = await runDevBind(h.input, hookDeps(h, { log: () => { throw new Error('log boom'); }, readRecent: () => unknown('x') }));
  assert.equal(g.exit, 0);
});

test('hook flow: the 8 s deadline bounds every subprocess and the lock wait', async () => {
  const h = hookWorld();
  bornAt(h, T0 + 24);
  seedLedger(h, [h.dev]);
  const seen = [];
  const run = (cmd, args, opts) => {
    seen.push(opts?.timeoutMs);
    return h.w.run(cmd, args);
  };
  let waitMs = null;
  await runDevBind(h.input, hookDeps(h, {
    run,
    acquire: async (name, o) => {
      waitMs = o.waitMs;
      return { name, dir: o.dir };
    },
    release: () => {},
  }));
  assert.ok(seen.length > 0 && seen.every((t) => t > 0 && t <= 3000), `every call has a timeout <= 3 s (${seen})`);
  assert.ok(waitMs !== null && waitMs <= 8000);
  // an already-expired deadline starts no subprocess and still returns 0
  const expired = hookWorld();
  bornAt(expired, T0 + 24);
  seedLedger(expired, [expired.dev]);
  const run0 = () => assert.fail('no subprocess after the deadline');
  const r = await runDevBind(expired.input, hookDeps(expired, { run: run0, deadlineMs: 0 }));
  assert.equal(r.exit, 0);
});

test('hook flow: two hooks racing for one listener bind it once (dev lock + re-read)', async () => {
  const h = hookWorld();
  bornAt(h, T0 + 24);
  seedLedger(h, [h.dev]);
  const first = hookDeps(h);
  const second = hookDeps(h);
  await Promise.all([runDevBind(h.input, first), runDevBind({ ...h.input, tool_use_id: 'tu2' }, second)]);
  assert.equal(ledgerLines(h).filter((e) => e.kind === 'dev-bind').length, 1);
});

test('hook flow win32: exit 0 with no I/O at all', async () => {
  const boom = () => assert.fail('no I/O on win32');
  const r = await runDevBind({ tool_name: 'Bash', session_id: 's1', tool_use_id: 't' }, {
    platform: 'win32', run: boom, readRecent: boom, appendEvent: boom, acquire: boom, release: boom, log: boom,
    get files() { return boom(); },
    get root() { return boom(); },
  });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.events, []);
});

// ---------------------------------------------------------------- the real hook entry

function e2e({ listenerPpid = 4300, sleepMs } = {}) {
  const d = dirs();
  const nowS = Math.floor(Date.now() / 1000);
  const ownerBirth = nowS - 3600;
  const owner = { pid: 4242, birth: parseLstart(lstart(ownerBirth)) };
  const ps = join(d.dir, 'ps.json');
  const lsof = join(d.dir, 'lsof.json');
  writeFileSync(ps, JSON.stringify({
    procs: {
      4242: { ppid: 1, comm: 'claude', lstart: lstart(ownerBirth) },
      4300: { ppid: 4242, comm: 'sh', lstart: lstart(nowS - 11) },
      5001: { ppid: listenerPpid, comm: 'node', lstart: lstart(nowS - 5) },
      777: { ppid: 1, comm: 'zsh', lstart: lstart(nowS - 9000) },
    },
    log: join(d.dir, 'ps.log'),
  }));
  writeFileSync(lsof, JSON.stringify({ listeners: { 3000: [5001] }, cwds: { 5001: d.wt }, log: join(d.dir, 'lsof.log'), ...(sleepMs ? { sleepMs } : {}) }));
  const env = {
    ...process.env,
    HOME: d.dir,
    PIPELINE_STACKS_HOME: d.root,
    PIPELINE_STACKS_ONLY: 'sa-corrections',
    PIPELINE_PS: FAKE_PS,
    PIPELINE_LSOF: FAKE_LSOF,
    FAKE_PS_SCENARIO: ps,
    FAKE_LSOF_SCENARIO: lsof,
    PIPELINE_MACHINE_ID: 'test-machine-id',
  };
  const tPre = new Date(Date.now() - 10000).toISOString();
  const dev = { t: tPre, kind: 'dev', session_id: 's1', tool_use_id: 'tu1', owner, cwd: d.wt, worktree: d.wt, tool: 'Bash', port: 3000, tPre };
  writeFileSync(d.files.ledger, `${JSON.stringify(dev)}\n`);
  const input = { tool_name: 'Bash', tool_input: { command: 'npm run dev' }, session_id: 's1', tool_use_id: 'tu1', cwd: d.wt };
  const hook = (stdin = JSON.stringify(input)) => {
    const started = performance.now();
    const r = spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8', timeout: 20000 });
    return { status: r.status, stderr: r.stderr, ms: performance.now() - started };
  };
  const lines = () => readFileSync(d.files.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { d, hook, lines, owner };
}

test('e2e: the real hook exits 0, appends dev-post and dev-bind for a descended listener (fake ps / lsof)', posixOnly, () => {
  const x = e2e();
  const r = x.hook();
  assert.equal(r.status, 0, r.stderr);
  const lines = x.lines();
  assert.deepEqual(lines.map((e) => e.kind), ['dev', 'dev-post', 'dev-bind']);
  assert.deepEqual(lines[2].owner, x.owner);
  assert.equal(lines[2].listenerPid, 5001);
  assert.equal(lines[2].cwd, x.d.wt);
});

test('e2e: a terminal-started listener is not bound (dev-post only); still exit 0', posixOnly, () => {
  const x = e2e({ listenerPpid: 777 });
  const r = x.hook();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(x.lines().map((e) => e.kind), ['dev', 'dev-post']);
});

test('e2e: bad stdin and a missing ledger still exit 0 (the failure is only logged)', posixOnly, () => {
  const x = e2e();
  assert.equal(x.hook('not json').status, 0);
  assert.ok(existsSync(x.d.files.log), 'a log line was left');
  assert.match(readFileSync(x.d.files.log, 'utf8'), /dev-bind hook failed/);
  rmSync(x.d.files.ledger);
  assert.equal(x.hook().status, 0);
  assert.equal(existsSync(x.d.files.ledger), false);
});

test('e2e: a hung lsof is cut off by the deadline; exit 0 well inside the hook timeout, nothing bound', posixOnly, () => {
  const x = e2e({ sleepMs: 15000 });
  const r = x.hook();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 9500, `took ${Math.round(r.ms)} ms`);
  assert.deepEqual(x.lines().map((e) => e.kind), ['dev', 'dev-post']);
});

test('e2e: without PIPELINE_STACKS_ONLY the fake ps / lsof overrides are ignored (R3-2)', posixOnly, () => {
  const x = e2e();
  const env = { ...process.env, HOME: x.d.dir, PIPELINE_STACKS_HOME: x.d.root, PIPELINE_PS: FAKE_PS, PIPELINE_LSOF: FAKE_LSOF, FAKE_PS_SCENARIO: join(x.d.dir, 'ps.json'), FAKE_LSOF_SCENARIO: join(x.d.dir, 'lsof.json'), PIPELINE_MACHINE_ID: 'test-machine-id' };
  delete env.PIPELINE_STACKS_ONLY;
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run dev' }, session_id: 's1', tool_use_id: 'tu1', cwd: x.d.wt });
  const r = spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(x.d.dir, 'lsof.log')), false, 'the fake lsof must not have been run');
  assert.equal(existsSync(join(x.d.dir, 'ps.log')), false, 'the fake ps must not have been run');
});
