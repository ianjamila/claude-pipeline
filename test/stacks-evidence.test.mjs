// Why: these probes decide whether a stack is still in use, so each one must fail closed and be strict where the tolerant
// worktree-prune probes are lenient: a hidden client still counts as a connection, a same-user process whose cwd cannot be
// read is unknown (not "elsewhere"), an unreadable directory or note is unknown (not empty), and a PR lookup that is
// incomplete or for another repository is unknown. Every test feeds real-shaped `lsof -F` / `ps` text (captured on macOS,
// trimmed) through an injected `run`; the real ps, lsof, gh and home are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, utimesSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { BRANCH_PRS_QUERY } from '../pipeline/lib/worktree-prune/prs.mjs';
import {
  resolveProbeBins, connections, processRefs, cwdInside, consumerWorktrees, prStates, transcriptRefs, memoryRefs, expandTranscriptDirs,
} from '../pipeline/lib/stacks/evidence.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const rootOnly = { skip: (process.platform === 'win32' && 'POSIX only') || (process.getuid?.() === 0 && 'chmod 000 does not stop root') };
const tmp = (name = 'stacks-ev ') => mkdtempSync(path.join(tmpdir(), name)); // the space is deliberate (Review Focus 2)
const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, pid: 7001, ...o });
const LSOF = '/fake/lsof';
const PS = '/fake/ps';
const LSTART = 'Mon Oct 19 02:47:17 2026';
const BIRTH = Date.UTC(2026, 9, 19, 2, 47, 17) / 1000;
const esrch = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
const alive = () => true;

const stack = {
  project: 'sa-corrections',
  folder: 'sa-corrections.stack',
  workdir: '/Users/me/My Stacks/sa-corrections.stack',
  ports: [54421, 54422],
};

// `ps -o lstart= -p <pid>` (procIdentity) answers from `lstart`; everything else goes to `other(cmd, args, opts)`.
function machine({ lstart = {}, lsof, other } = {}) {
  const calls = [];
  const run = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === PS && args[0] === '-o' && args[1] === 'lstart=') {
      const pid = args[3];
      return pid in lstart ? res({ stdout: `${lstart[pid]}\n`, pid: 7900 }) : res({ code: 1, pid: 7900 });
    }
    if (cmd === LSOF && lsof) return typeof lsof === 'function' ? lsof(args, opts) : lsof;
    return other ? other(cmd, args, opts) : res({ code: 1, stderr: `unexpected ${cmd} ${args.join(' ')}` });
  };
  run.calls = calls;
  return run;
}

// ---- lsof -F pcnT, as `lsof -nP -w -iTCP -sTCP:LISTEN,ESTABLISHED -F pcnT` prints it on macOS (OrbStack publishes the ports) ----
const HELPER = [
  'p1201', 'cOrbStack Helper',
  'f20', 'n*:54422', 'TST=LISTEN', 'TQR=0', 'TQS=0',
  'f21', 'n*:54421', 'TST=LISTEN', 'TQR=0', 'TQS=0',
  'f22', 'n*:54320', 'TST=LISTEN', 'TQR=0', 'TQS=0',
];
const serverSide = (client, port = 54422) => ['f30', `n127.0.0.1:${port}->127.0.0.1:${client}`, 'TST=ESTABLISHED', 'TQR=0', 'TQS=0'];
const clientProc = (pid, cmd, client, port = 54422) => [`p${pid}`, `c${cmd}`, 'f15', `n127.0.0.1:${client}->127.0.0.1:${port}`, 'TST=ESTABLISHED', 'TQR=0', 'TQS=0'];
const text = (...parts) => `${parts.flat().join('\n')}\n`;
const connOpts = (run, extra = {}) => ({ run, lsof: LSOF, ps: PS, platform: 'darwin', kill: esrch, ...extra });

test('connections: the helper side is the connection, the node client names it (pid, birth, command, port)', () => {
  const out = text(HELPER, serverSide(61234), clientProc(9001, 'node', 61234));
  const run = machine({ lsof: res({ stdout: out }), lstart: { 9001: LSTART } });
  const r = connections(stack, connOpts(run));
  assert.deepEqual(r, { ok: true, value: [{ pid: 9001, birth: BIRTH, command: 'node', port: 54422 }] });
  const call = run.calls.find((c) => c.cmd === LSOF);
  assert.deepEqual(call.args, ['-nP', '-w', '-iTCP', '-sTCP:LISTEN,ESTABLISHED', '-F', 'pcnT']);
});

test('connections: a stack port whose listener is not visible is unknown (positive control)', () => {
  const out = text(HELPER.slice(0, 7), clientProc(9001, 'node', 61234)); // 54421 listener missing
  const r = connections(stack, connOpts(machine({ lsof: res({ stdout: out }) })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /port 54421 listener not visible/);
});

test('connections: server side ESTABLISHED with no matching client socket is a hidden client, not unknown, not ignored', () => {
  const out = text(HELPER, serverSide(61999)); // another user's process: its socket is invisible to lsof
  const r = connections(stack, connOpts(machine({ lsof: res({ stdout: out }) })));
  assert.deepEqual(r, { ok: true, value: [{ pid: null, birth: null, command: 'hidden client', port: 54422 }] });
});

test('connections: listeners present and zero established sockets => ok([])', () => {
  const r = connections(stack, connOpts(machine({ lsof: res({ stdout: text(HELPER) }) })));
  assert.deepEqual(r, { ok: true, value: [] });
});

test('connections: lsof exit 1 is fine when the control passes; signal, timeout and exit 2 are unknown', () => {
  const out = text(HELPER);
  assert.deepEqual(connections(stack, connOpts(machine({ lsof: res({ code: 1, stdout: out }) }))), { ok: true, value: [] });
  for (const bad of [{ signal: 'SIGKILL', code: 1 }, { timedOut: true, code: 124 }, { code: 2 }]) {
    const r = connections(stack, connOpts(machine({ lsof: res({ ...bad, stdout: out }) })));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('connections: a client lsof sees but whose server side it does not is still a connection; IPv6 names parse', () => {
  const out = text(HELPER, clientProc(9002, 'psql', 61500), ['p9003', 'cnode', 'f9', 'n[::1]:61600->[::1]:54421', 'TST=ESTABLISHED'], ['p1202', 'cOrbStack Helper', 'f9', 'n[::1]:54421->[::1]:61600', 'TST=ESTABLISHED']);
  const run = machine({ lsof: res({ stdout: out }), lstart: { 9002: LSTART } });
  const r = connections(stack, connOpts(run));
  assert.equal(r.ok, true);
  const bySocket = Object.fromEntries(r.value.map((c) => [c.port, c]));
  assert.equal(bySocket[54422].pid, 9002);
  assert.equal(bySocket[54422].birth, BIRTH);
  assert.equal(bySocket[54421].pid, 9003);
  assert.equal(bySocket[54421].birth, null, 'no lstart for 9003 => birth null');
  assert.equal(r.value.length, 2);
});

test('connections: no -T lines (older lsof) still parse; a file record ends at the next n', () => {
  const out = text(['p1201', 'cOrbStack Helper', 'f20', 'n*:54422', 'TST=LISTEN', 'f21', 'n*:54421', 'TST=LISTEN'], ['p9001', 'cnode', 'n127.0.0.1:61234->127.0.0.1:54422', 'TST=ESTABLISHED', 'n127.0.0.1:61235->127.0.0.1:54422', 'TST=ESTABLISHED']);
  const r = connections(stack, connOpts(machine({ lsof: res({ stdout: out }), lstart: { 9001: LSTART } })));
  assert.equal(r.ok, true);
  assert.equal(r.value.length, 2);
});

test('connections: deadline bounds the call; exhausted deadline is unknown without a run; Windows never runs', () => {
  const run = machine({ lsof: res({ stdout: text(HELPER) }) });
  connections(stack, connOpts(run, { deadlineAt: 1_000 + 4_000, now: () => 1_000 }));
  assert.equal(run.calls.find((c) => c.cmd === LSOF).opts.timeoutMs, 4000);
  const run2 = machine({ lsof: res({ stdout: text(HELPER) }) });
  connections(stack, connOpts(run2, { deadlineAt: 1_000 + 60_000, now: () => 1_000 }));
  assert.equal(run2.calls.find((c) => c.cmd === LSOF).opts.timeoutMs, 15000);
  const run3 = machine({});
  const late = connections(stack, connOpts(run3, { deadlineAt: 1_100, now: () => 1_000 }));
  assert.deepEqual(late, { ok: false, reason: 'deadline' });
  assert.equal(run3.calls.length, 0);
  const run4 = machine({});
  assert.deepEqual(connections(stack, { run: run4, lsof: LSOF, ps: PS, platform: 'win32' }), { ok: false, reason: 'windows' });
  assert.equal(run4.calls.length, 0);
});

// ---- processRefs: `ps -axww -o pid=,uid=,command=` then `ps -axE -ww -o pid=,command=` with a nonce in ps's own env ----
const OWN_UID = 501;
function psMachine({ cmdLines, envLines, nonceVisible = true, ownLine1 = true, ownLine2 = true, code1 = 0, code2 = 0, lstart = {} }) {
  return machine({
    lstart,
    other: (cmd, args, opts) => {
      if (cmd !== PS) return res({ code: 1, stderr: 'unexpected' });
      if (args[0] === '-axE') {
        const nonce = opts.env.PIPELINE_STACKS_PROBE;
        const own = ownLine2 ? [`${7002} /bin/ps -axE -ww -o pid=,command= ${nonceVisible ? `PIPELINE_STACKS_PROBE=${nonce} ` : ''}LC_ALL=en_US.UTF-8`] : [];
        return res({ code: code2, pid: 7002, stdout: text(envLines, own) });
      }
      return res({ code: code1, pid: 7001, stdout: text(cmdLines, ownLine1 ? ['  7001   501 /bin/ps -axww -o pid=,uid=,command='] : []) });
    },
  });
}
const refOpts = (run, extra = {}) => ({ run, ps: PS, platform: 'darwin', uid: OWN_UID, kill: esrch, nonce: 'n0nce', ownPid: 8000, ...extra });
const LISTING = [
  '    1     0 /sbin/launchd',
  '  500   501 /Applications/Cursor.app/Contents/MacOS/Cursor',
  ' 4001   501 node /Users/me/Dev Projects/.worktrees/web/node_modules/.bin/next dev',
  ' 4002   501 supabase start --workdir /Users/me/My Stacks/sa-corrections.stack',
  ' 4003   501 node app.js',
  ' 4004   501 node /Users/me/x/sa-corrections-followups/run.js',
  ' 4005   502 psql postgresql://postgres@127.0.0.1:54422/postgres',
  ' 4006   501 docker logs supabase_db_sa-corrections',
];
const ENVS = [
  '    1 /sbin/launchd',
  '  500 /Applications/Cursor.app/Contents/MacOS/Cursor HOME=/Users/me',
  ' 4001 node /Users/me/Dev Projects/.worktrees/web/node_modules/.bin/next dev HOME=/Users/me',
  ' 4002 supabase start --workdir /Users/me/My Stacks/sa-corrections.stack HOME=/Users/me',
  ' 4003 node app.js HOME=/Users/me SUPABASE_URL=http://127.0.0.1:54421 PWD=/Users/me/web',
  ' 4004 node /Users/me/x/sa-corrections-followups/run.js HOME=/Users/me',
  ' 4006 docker logs supabase_db_sa-corrections HOME=/Users/me',
];

test('processRefs: cmdline hits (folder/workdir, container, other-user port), env-only hit is field env, followups id does not match', () => {
  const run = psMachine({ cmdLines: LISTING, envLines: ENVS, lstart: { 4002: LSTART, 4003: LSTART } });
  const r = processRefs(stack, refOpts(run));
  assert.equal(r.ok, true);
  const byPid = Object.fromEntries(r.value.map((h) => [h.pid, h]));
  assert.deepEqual(Object.keys(byPid).sort(), ['4002', '4003', '4005', '4006']);
  assert.equal(byPid[4002].field, 'cmdline');
  assert.equal(byPid[4002].birth, BIRTH);
  assert.equal(byPid[4003].field, 'env');
  assert.equal(byPid[4003].command, 'node app.js');
  assert.equal(byPid[4005].field, 'cmdline'); // another user's psql: the command line is visible
  assert.equal(byPid[4006].birth, null, 'identity unknown => birth null, hit kept');
  assert.equal(r.hidden, 2, 'launchd (uid 0) and the other user psql: environments that cannot be read');
  // the env ps carries the nonce, and neither ps is one of the hits
  const envCall = run.calls.find((c) => c.args[0] === '-axE');
  assert.equal(envCall.opts.env.PIPELINE_STACKS_PROBE, 'n0nce');
  assert.deepEqual(envCall.args, ['-axE', '-ww', '-o', 'pid=,command=']);
  assert.deepEqual(run.calls.find((c) => c.args[0] === '-axww').args, ['-axww', '-o', 'pid=,uid=,command=']);
});

test('processRefs: hyphenated id does not match inside a longer name but does match <id>.stack', () => {
  const s = { project: 'sub-detachments', folder: 'sub-detachments.stack', workdir: null, ports: [] };
  const lines = [' 10   501 node /w/sub-detachments-followups/run.js', ' 11   501 node /w/stacks/sub-detachments.stack/x.js', ' 12   501 node /w/sub-detachments_old/y.js', ' 13   501 node /w/pre-sub-detachments.stack/z.js'];
  const run = psMachine({ cmdLines: lines, envLines: lines.map((l) => l.replace(/^(\s*\d+)\s+\d+/, '$1')) });
  const r = processRefs(s, refOpts(run));
  assert.deepEqual(r.value.map((h) => h.pid), [11]);
});

test('processRefs: the probe itself, excluded pids and the caller are never hits', () => {
  const cmd = [...LISTING, ' 8000   501 node worker sa-corrections.stack'];
  const env = [...ENVS, ' 8000 node worker sa-corrections.stack'];
  const run = psMachine({ cmdLines: cmd, envLines: [...env, ' 7001 /bin/ps sa-corrections.stack'] });
  const r = processRefs(stack, refOpts(run, { excludePids: new Set([8000, 4002]) }));
  assert.deepEqual(r.value.map((h) => h.pid).sort(), [4003, 4005, 4006]);
});

test('processRefs: ps does not show its own environment (nonce missing) => unknown', () => {
  const r = processRefs(stack, refOpts(psMachine({ cmdLines: LISTING, envLines: ENVS, nonceVisible: false })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /nonce|environment/i);
});

test('processRefs: ps own line missing, ps failing or timing out => unknown', () => {
  assert.equal(processRefs(stack, refOpts(psMachine({ cmdLines: LISTING, envLines: ENVS, ownLine1: false }))).ok, false);
  assert.equal(processRefs(stack, refOpts(psMachine({ cmdLines: LISTING, envLines: ENVS, ownLine2: false }))).ok, false);
  assert.equal(processRefs(stack, refOpts(psMachine({ cmdLines: LISTING, envLines: ENVS, code1: 1 }))).ok, false);
  assert.equal(processRefs(stack, refOpts(psMachine({ cmdLines: LISTING, envLines: ENVS, code2: 2 }))).ok, false);
});

test('processRefs: a command line with an embedded newline stays attached to its process; Windows never runs', () => {
  const lines = [' 20   501 sh -c echo one', 'sa-corrections.stack two'];
  const run = psMachine({ cmdLines: lines, envLines: [' 20 sh -c echo one', 'sa-corrections.stack two'] });
  assert.deepEqual(processRefs(stack, refOpts(run)).value.map((h) => h.pid), [20]);
  const run2 = machine({});
  assert.deepEqual(processRefs(stack, { run: run2, ps: PS, platform: 'win32' }), { ok: false, reason: 'windows' });
  assert.equal(run2.calls.length, 0);
});

// ---- cwdInside: ps uid snapshot first, then whole-machine `lsof -n -P -w -F pfn` ----
const DIRS = ['/Users/me/Dev Projects/.worktrees/web', '/Users/me/My Stacks/sa-corrections.stack'];
const cwdProc = (pid, cwd, ...more) => [`p${pid}`, 'fcwd', `n${cwd}`, ...more];
function cwdMachine({ snapshot, lsofOut, lsofCode = 0, lstart = {} }) {
  return machine({
    lstart,
    lsof: res({ code: lsofCode, pid: 7002, stdout: lsofOut }),
    other: (cmd, args) => {
      if (cmd === PS && args[0] === '-axo') return res({ pid: 7001, stdout: text(snapshot, ['  7001   501 R']) });
      return res({ code: 1, stderr: 'unexpected' });
    },
  });
}
const cwdOpts = (run, extra = {}) => ({ run, lsof: LSOF, ps: PS, platform: 'darwin', uid: OWN_UID, ownPid: 8000, kill: esrch, ...extra });
const SNAP = ['    1     0 Ss', '  500   501 S', ' 4001   501 S', ' 4002   501 S', ' 5001   502 S', ' 8000   501 S'];
const baseLsof = (...extra) => text(cwdProc(1, '/'), cwdProc(500, '/Users/me'), cwdProc(4002, '/Users/me/other'), cwdProc(8000, '/Users/me/elsewhere'), ...extra);

test('cwdInside: a process with its cwd (or an open file) inside a dir is a hit; spaces in paths hold', () => {
  const out = baseLsof(cwdProc(4001, '/Users/me/Dev Projects/.worktrees/web/packages/app', 'ftxt', 'n/usr/bin/node'));
  const run = cwdMachine({ snapshot: SNAP, lsofOut: out, lstart: { 4001: LSTART } });
  const r = cwdInside(DIRS, cwdOpts(run));
  assert.deepEqual(r.ok && r.value, [{ pid: 4001, birth: BIRTH, dir: DIRS[0] }]);
  assert.equal(r.hidden, 1, 'pid 5001 belongs to another user and has no visible cwd');
  const order = run.calls.map((c) => c.cmd + (c.args[0] === '-axo' ? ':snapshot' : ''));
  assert.ok(order.indexOf(`${PS}:snapshot`) < order.indexOf(LSOF), 'snapshot first');
  assert.deepEqual(run.calls.find((c) => c.cmd === LSOF).args, ['-n', '-P', '-w', '-F', 'pfn']);
});

test('cwdInside: ancestors of the stack folder (/, home, its parent) are never inside it; a process in it is', () => {
  const folder = '/private/tmp/claude-501/-Users-me/abc/scratchpad/smoke/proj';
  const out = text(
    cwdProc(1, '/'), cwdProc(500, '/Users/me'), cwdProc(4002, '/private/tmp/x'), cwdProc(8000, '/Users/me/elsewhere'),
    cwdProc(4001, `${folder}/supabase`, 'ftxt', 'n/usr/bin/node'),
  );
  const run = cwdMachine({ snapshot: SNAP, lsofOut: out, lstart: { 4001: LSTART } });
  const r = cwdInside([folder], cwdOpts(run));
  assert.deepEqual(r.ok && r.value, [{ pid: 4001, birth: BIRTH, dir: folder }]);
});

test('cwdInside: a nothing-inside machine is ok([]), and the probe children are excluded from hits', () => {
  assert.deepEqual(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: baseLsof(cwdProc(4001, '/Users/me/y')) }))).value, []);
  const withProbe = baseLsof(cwdProc(4001, '/Users/me/y'), cwdProc(7002, DIRS[1]), cwdProc(7001, DIRS[1]));
  assert.deepEqual(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: withProbe }))).value, []);
  const caller = baseLsof(cwdProc(4001, DIRS[0]));
  assert.deepEqual(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: caller, lstart: { 4001: LSTART } }), { excludePids: new Set([4001]) })).value, []);
});

test('cwdInside: a same-uid pid listed without a readable cwd is unknown', () => {
  const out = baseLsof(['p4001', 'ftxt', 'n/usr/bin/node']); // listed, but no fcwd
  const r = cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: out })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /4001/);
});

test('cwdInside: a same-uid pid absent from lsof is unknown while alive and fine once gone', () => {
  const out = baseLsof(); // 4001 absent
  const aliveRun = cwdMachine({ snapshot: SNAP, lsofOut: out, lstart: { 4001: LSTART } });
  assert.equal(cwdInside(DIRS, cwdOpts(aliveRun, { kill: alive })).ok, false);
  const gone = cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: out }))); // ps: no such pid, kill: ESRCH
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.value, []);
});

test('cwdInside: a zombie has no cwd and is not a reason to give up', () => {
  const snap = [...SNAP.slice(0, 2), ' 4001   501 Z+', ...SNAP.slice(3)];
  const r = cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: snap, lsofOut: baseLsof() })));
  assert.equal(r.ok, true);
});

test('cwdInside: positive control (the caller itself must show a cwd), lsof/ps failures are unknown', () => {
  const blind = text(cwdProc(1, '/'), cwdProc(500, '/Users/me'), cwdProc(4001, '/x'), cwdProc(4002, '/y'));
  assert.equal(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: blind }))).ok, false);
  assert.equal(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: baseLsof(), lsofCode: 2 }))).ok, false);
  assert.equal(cwdInside(DIRS, cwdOpts(cwdMachine({ snapshot: SNAP, lsofOut: baseLsof(), lsofCode: 1 }))).ok, true, 'exit 1 is lsof for "some items not examined"');
  const badPs = machine({ other: () => res({ code: 1, stderr: 'ps: nope' }), lsof: res({ stdout: baseLsof() }) });
  assert.equal(cwdInside(DIRS, cwdOpts(badPs)).ok, false);
});

test('cwdInside: a path reached through macOS firmlink spelling still counts; Windows never runs', () => {
  const out = baseLsof(cwdProc(4001, '/System/Volumes/Data/Users/me/Dev Projects/.worktrees/web/x'));
  const run = cwdMachine({ snapshot: SNAP, lsofOut: out, lstart: { 4001: LSTART } });
  assert.equal(cwdInside(DIRS, cwdOpts(run)).value.length, 1);
  const run2 = machine({});
  assert.deepEqual(cwdInside(DIRS, { run: run2, lsof: LSOF, ps: PS, platform: 'win32' }), { ok: false, reason: 'windows' });
  assert.equal(run2.calls.length, 0);
});

// ---- consumerWorktrees ----
function makeRepo() {
  const base = tmp();
  const mk = (name, env) => {
    const dir = path.join(base, '.worktrees', name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(env ?? {})) writeFileSync(path.join(dir, file), body);
    return dir;
  };
  return { base, mk };
}
const wtEntry = (p, branch) => ({ path: p, head: 'a'.repeat(40), branch, bare: false, locked: null, prunable: false, detached: false });
const stackSa = { project: 'sa', folder: 'sa.stack', workdir: '/Users/me/stacks/sa.stack', ports: [54421] };

test('consumerWorktrees: ledger worktrees (not "none", not other stacks) and .env files naming a stack port', () => {
  const { base, mk } = makeRepo();
  const a = mk('a', { '.env.local': 'NEXT_PUBLIC_SUPABASE_URL=http://localhost:54421\n' });
  const b = mk('b', { '.env': 'URL=http://localhost:54999\n' });
  const c = mk('c', { '.env.test': 'URL=http://127.0.0.1:544210\n' }); // port prefix, not the port
  const gone = path.join(base, '.worktrees', 'gone');
  const events = [
    { kind: 'use', project: 'sa', worktree: gone },
    { kind: 'use', project: 'sa', worktree: 'none' },
    { kind: 'use', project: 'other', worktree: b },
    { kind: 'use', project: 'sa', worktree: gone },
  ];
  const listWorktrees = () => [wtEntry(base, 'main'), wtEntry(a, 'feat/a'), wtEntry(b, 'feat/b'), wtEntry(c, 'feat/c')];
  const r = consumerWorktrees(stackSa, { events, repos: [base], listWorktrees, platform: 'darwin' });
  assert.equal(r.ok, true);
  const byPath = Object.fromEntries(r.value.map((w) => [w.path, w]));
  assert.deepEqual(Object.keys(byPath).sort(), [a, gone].sort());
  assert.deepEqual([byPath[a].via, byPath[a].exists, byPath[a].branch], ['env', true, 'feat/a']);
  assert.deepEqual([byPath[gone].via, byPath[gone].exists], ['ledger', false]);
});

test('consumerWorktrees: transcript backfill ties a session whose Bash --workdir names the stack to its cwd worktree', () => {
  const { base, mk } = makeRepo();
  const wt = mk('t');
  const dirs = tmp('stacks-tr ');
  const proj = path.join(dirs, '-Users-me-proj');
  mkdirSync(proj, { recursive: true });
  const line = (cwd, command) => JSON.stringify({ cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  writeFileSync(path.join(proj, 's1.jsonl'), `${line(path.join(wt, 'sub'), 'supabase start --workdir /Users/me/stacks/sa.stack')}\n${line(base, 'ls /Users/me/stacks/sa.stack')}\n`);
  const listWorktrees = () => [wtEntry(base, 'main'), wtEntry(wt, 'feat/t')];
  const r = consumerWorktrees(stackSa, { events: [], transcripts: { dirs: [dirs], sinceMs: 0 }, repos: [base], listWorktrees, platform: 'darwin' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((w) => [w.path, w.via, w.branch]), [[wt, 'transcript', 'feat/t']], 'cwd resolves to the worktree, and only the --workdir command counts');
});

test('consumerWorktrees: a transcript cwd that is / , the home directory or an ancestor of the stack folder is dropped with a note', () => {
  const { base, mk } = makeRepo();
  const wt = mk('t');
  const dirs = tmp('stacks-tr ');
  const proj = path.join(dirs, '-Users-me-proj');
  mkdirSync(proj, { recursive: true });
  const line = (cwd) => JSON.stringify({ cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'supabase status --workdir /Users/me/stacks/sa.stack' } }] } });
  const cwds = ['/', '/Users', '/Users/me', '/Users/me/stacks', path.join(wt, 'sub'), '/Users/me/elsewhere/proj'];
  writeFileSync(path.join(proj, 's1.jsonl'), `${cwds.map(line).join('\n')}\n`);
  const listWorktrees = () => [wtEntry(base, 'main'), wtEntry(wt, 'feat/t')];
  const r = consumerWorktrees(stackSa, { events: [], transcripts: { dirs: [dirs], sinceMs: 0 }, repos: [base], listWorktrees, platform: 'darwin', home: '/Users/me' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((w) => w.path).sort(), [wt, '/Users/me/elsewhere/proj'].sort());
  for (const dropped of ['/', '/Users', '/Users/me', '/Users/me/stacks']) {
    assert.ok(r.notes.some((n) => n.includes(JSON.stringify(dropped)) || n.includes(`${dropped} `)), `a note names ${dropped}`);
  }
});

test('consumerWorktrees: win32 => unknown, no I/O', () => {
  const noIo = () => assert.fail('no I/O on win32');
  assert.deepEqual(consumerWorktrees(stackSa, { events: [], transcripts: { dirs: ['/x'], sinceMs: 0 }, repos: ['/r'], listWorktrees: noIo, platform: 'win32' }), { ok: false, reason: 'windows' });
});

test('consumerWorktrees: an unreadable worktree directory is unknown, not "no env files"', rootOnly, () => {
  const { base, mk } = makeRepo();
  const a = mk('locked');
  chmodSync(a, 0o000);
  try {
    const r = consumerWorktrees(stackSa, { events: [], repos: [base], listWorktrees: () => [wtEntry(a, 'x')], platform: 'darwin' });
    assert.equal(r.ok, false);
  } finally {
    chmodSync(a, 0o755);
  }
});

test('consumerWorktrees: a worktree listing that fails is unknown; Windows never lists', () => {
  const boom = () => { throw new Error('git exploded'); };
  assert.equal(consumerWorktrees(stackSa, { events: [], repos: ['/r'], listWorktrees: boom, platform: 'darwin' }).ok, false);
  let called = 0;
  const r = consumerWorktrees(stackSa, { events: [], repos: ['/r'], listWorktrees: () => { called += 1; return []; }, platform: 'win32' });
  assert.deepEqual(r, { ok: false, reason: 'windows' });
  assert.equal(called, 0);
});

// ---- prStates ----
const SHA = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const prNode = (o) => ({ number: 5, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-02T00:00:00Z', headRefName: 'feat/x', headRefOid: SHA, isCrossRepository: false, headRepository: { nameWithOwner: 'acme/widgets' }, ...o });
const okJson = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: '', timedOut: false });
const repoView = okJson({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
const prPage = (nodes, hasNextPage = false, endCursor = null) => okJson({ data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } } });

function prWorld({ nodes = [], branch = 'feat/x', sha = SHA, origin = 'git@github.com:acme/widgets.git', pages, ghError } = {}) {
  const ghCalls = [];
  const gitCalls = [];
  const ghFn = (args) => {
    ghCalls.push(args);
    if (ghError) return { code: 1, stdout: '', stderr: 'HTTP 502', timedOut: false };
    if (args[0] === 'repo') return repoView;
    return pages ? pages(args, ghCalls.length) : prPage(nodes);
  };
  const git = (args, { cwd } = {}) => {
    gitCalls.push([cwd, ...args]);
    const key = args.join(' ');
    if (key === 'rev-parse --abbrev-ref HEAD') return `${branch}\n`;
    if (key === 'rev-parse HEAD') return `${sha}\n`;
    if (key === 'remote get-url origin') return `${origin}\n`;
    if (key === 'rev-parse --git-common-dir') return '.git\n';
    throw new Error(`unexpected git ${key}`);
  };
  return { ghFor: (cwd) => createGitHub({ cwd, ghFn }), git, ghCalls, gitCalls };
}
const wtList = (...ps) => ps.map((p) => ({ path: p, exists: true, branch: null, via: 'ledger' }));

test('prStates: any OPEN PR wins; a merged PR whose head equals HEAD is MERGED+headMatches; GraphQL asks exactly the fields the helper parses', () => {
  const w = prWorld({ nodes: [prNode({ number: 1, state: 'MERGED' }), prNode({ number: 2, state: 'OPEN', headRefOid: OTHER, mergedAt: null })] });
  const open = prStates(wtList('/w/a'), { ...w, exists: () => true, platform: 'darwin' });
  assert.deepEqual([...open.value], [['/w/a', { state: 'OPEN', headMatches: false, eligible: false }]]);
  const m = prWorld({ nodes: [prNode({ number: 1, state: 'CLOSED', headRefOid: OTHER }), prNode({ number: 3, state: 'MERGED' })] });
  const merged = prStates(wtList('/w/a'), { ...m, exists: () => true, platform: 'darwin' });
  assert.deepEqual([...merged.value], [['/w/a', { state: 'MERGED', headMatches: true, eligible: true }]]);
  for (const f of ['number', 'state', 'createdAt', 'headRefName', 'headRefOid']) assert.match(BRANCH_PRS_QUERY, new RegExp(`\\b${f}\\b`));
  assert.ok(m.ghCalls.some((a) => a.some((s) => String(s).includes('branch=feat/x'))));
});

test('prStates: PRs exist but none has HEAD => the newest created, headMatches false (not eligible); no PR => NONE', () => {
  const w = prWorld({ nodes: [prNode({ number: 1, state: 'MERGED', headRefOid: OTHER, createdAt: '2026-09-01T00:00:00Z' }), prNode({ number: 2, state: 'CLOSED', headRefOid: 'e'.repeat(40), createdAt: '2026-10-05T00:00:00Z' })] });
  const r = prStates(wtList('/w/a'), { ...w, exists: () => true, platform: 'darwin' });
  assert.deepEqual([...r.value], [['/w/a', { state: 'CLOSED', headMatches: false, eligible: false }]]);
  const none = prStates(wtList('/w/a'), { ...prWorld({ nodes: [] }), exists: () => true, platform: 'darwin' });
  assert.deepEqual([...none.value], [['/w/a', { state: 'NONE', headMatches: false, eligible: false }]]);
});

test('prStates: PRs of other branches are ignored; a second page is followed', () => {
  const pages = (args, n) => (n <= 2 ? prPage([prNode({ number: 9, headRefName: 'feat/x-2' })], true, 'c1') : prPage([prNode({ number: 10 })]));
  const w = prWorld({ pages });
  const r = prStates(wtList('/w/a'), { ...w, exists: () => true, platform: 'darwin' });
  assert.equal(r.value.get('/w/a').state, 'MERGED');
});

test('prStates: repo mismatch, a page error, detached HEAD or a bad sha are unknown', () => {
  const wrongRepo = prWorld({ nodes: [prNode()], origin: 'git@github.com:other/repo.git' });
  assert.equal(prStates(wtList('/w/a'), { ...wrongRepo, exists: () => true, platform: 'darwin' }).ok, false);
  const err = prWorld({ ghError: true });
  assert.equal(prStates(wtList('/w/a'), { ...err, exists: () => true, platform: 'darwin' }).ok, false);
  const failPage = prWorld({ pages: (a, n) => (n <= 2 ? prPage([prNode()], true, 'c1') : { code: 1, stdout: '', stderr: 'HTTP 500', timedOut: false }) });
  assert.equal(prStates(wtList('/w/a'), { ...failPage, exists: () => true, platform: 'darwin' }).ok, false);
  assert.equal(prStates(wtList('/w/a'), { ...prWorld({ branch: 'HEAD' }), exists: () => true, platform: 'darwin' }).ok, false);
  assert.equal(prStates(wtList('/w/a'), { ...prWorld({ sha: 'abc' }), exists: () => true, platform: 'darwin' }).ok, false);
});

test('prStates: a worktree that no longer exists is eligible without any git or gh call', () => {
  const w = prWorld({ nodes: [prNode({ state: 'OPEN' })] });
  const r = prStates([{ path: '/w/gone', exists: false, branch: null, via: 'ledger' }], { ...w, exists: () => false, platform: 'darwin' });
  assert.deepEqual([...r.value], [['/w/gone', { state: 'GONE', headMatches: true, eligible: true }]]);
  assert.equal(w.ghCalls.length + w.gitCalls.length, 0);
  assert.deepEqual(prStates(wtList('/w/a'), { ...w, platform: 'win32' }), { ok: false, reason: 'windows' });
});

// ---- transcripts, memory ----
test('expandTranscriptDirs: expands <home>/.claude*/projects strictly; a missing root is a note, an unreadable home is unknown', posixOnly, () => {
  const home = tmp('stacks-home ');
  mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(path.join(home, '.claude-eaglewatch', 'projects'), { recursive: true });
  mkdirSync(path.join(home, '.claude9'), { recursive: true }); // no projects dir
  writeFileSync(path.join(home, '.claude.json'), '{}'); // matches the glob, but it is a file
  const r = expandTranscriptDirs([path.join(home, '.claude*', 'projects')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.sort(), [path.join(home, '.claude', 'projects'), path.join(home, '.claude-eaglewatch', 'projects'), path.join(home, '.claude9', 'projects')].sort());
  const missing = transcriptRefs(stackSa, { dirs: [path.join(home, '.claude9', 'projects')], sinceMs: 0, platform: 'darwin' });
  assert.deepEqual(missing.ok && missing.value, []);
  assert.match(missing.notes.join(' '), /does not exist/);
  assert.deepEqual(expandTranscriptDirs([path.join(home, 'nope', '.claude*', 'projects')]).ok, false);
});

test('expandTranscriptDirs: an unreadable home is unknown', rootOnly, () => {
  const home = tmp('stacks-home ');
  mkdirSync(path.join(home, 'h'));
  chmodSync(path.join(home, 'h'), 0o000);
  try {
    assert.equal(expandTranscriptDirs([path.join(home, 'h', '.claude*', 'projects')]).ok, false);
  } finally {
    chmodSync(path.join(home, 'h'), 0o755);
  }
});

test('transcriptRefs: a recent transcript whose tool call or cwd names the stack counts; tool output and old files do not', () => {
  const dirs = tmp('stacks-tr ');
  const proj = path.join(dirs, 'p');
  mkdirSync(proj, { recursive: true });
  const tool = (command) => JSON.stringify({ cwd: '/w', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const result = JSON.stringify({ cwd: '/w', message: { content: [{ type: 'tool_result', content: 'sa.stack listed here' }] } });
  writeFileSync(path.join(proj, 'hit.jsonl'), `${tool('supabase status --workdir /Users/me/stacks/sa.stack')}\n`);
  writeFileSync(path.join(proj, 'idhit.jsonl'), `${tool('docker logs supabase_db_sa')}\n`);
  writeFileSync(path.join(proj, 'other.jsonl'), `${tool('docker logs supabase_db_sa-two')}\n`);
  writeFileSync(path.join(proj, 'output.jsonl'), `${result}\n`);
  const old = path.join(proj, 'old.jsonl');
  writeFileSync(old, `${tool('supabase status --workdir /Users/me/stacks/sa.stack')}\n`);
  utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  const r = transcriptRefs(stackSa, { dirs: [dirs], sinceMs: Date.now() - 24 * 3600 * 1000, platform: 'darwin' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((f) => path.basename(f)).sort(), ['hit.jsonl', 'idhit.jsonl']);
});

test('transcriptRefs: an unreadable recent transcript or project directory is unknown', rootOnly, () => {
  const dirs = tmp('stacks-tr ');
  const proj = path.join(dirs, 'p');
  mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 'locked.jsonl');
  writeFileSync(f, '{}\n');
  chmodSync(f, 0o000);
  try {
    assert.equal(transcriptRefs(stackSa, { dirs: [dirs], sinceMs: 0, platform: 'darwin' }).ok, false);
  } finally {
    chmodSync(f, 0o644);
  }
  chmodSync(proj, 0o000);
  try {
    assert.equal(transcriptRefs(stackSa, { dirs: [dirs], sinceMs: 0, platform: 'darwin' }).ok, false);
  } finally {
    chmodSync(proj, 0o755);
  }
  assert.deepEqual(transcriptRefs(stackSa, { dirs: [dirs], sinceMs: 0, platform: 'win32' }), { ok: false, reason: 'windows' });
});

function notes() {
  const dir = tmp('stacks-mem ');
  writeFileSync(path.join(dir, 'a.md'), 'The sa.stack stack is private.\n');
  writeFileSync(path.join(dir, 'b.md'), 'nothing relevant, sa-corrections-followups only\n');
  writeFileSync(path.join(dir, 'supabase-stack-autostop.md'), 'mentions sa and sa.stack everywhere\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'sa.stack but not markdown\n');
  return dir;
}

test('memoryRefs: a note naming the project id or folder counts; the exclude list is honoured; non-md files are ignored', () => {
  const dir = notes();
  const r = memoryRefs(stackSa, { dirs: [dir], exclude: ['supabase-stack-autostop.md', 'MEMORY-archive.md'], platform: 'darwin' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((f) => path.basename(f)), ['a.md']);
  const all = memoryRefs(stackSa, { dirs: [dir], exclude: [], platform: 'darwin' });
  assert.deepEqual(all.value.map((f) => path.basename(f)).sort(), ['a.md', 'supabase-stack-autostop.md']);
});

test('memoryRefs: an unreadable note is unknown (even an excluded name is not read)', () => {
  const dir = notes();
  const readFile = (f, enc) => {
    if (f.endsWith('b.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return readFileSync(f, enc);
  };
  const r = memoryRefs(stackSa, { dirs: [dir], exclude: ['supabase-stack-autostop.md'], readFile, platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /b\.md/);
  // an excluded unreadable note does not matter
  const r2 = memoryRefs(stackSa, { dirs: [dir], exclude: ['b.md', 'supabase-stack-autostop.md'], readFile, platform: 'darwin' });
  assert.equal(r2.ok, true);
});

test('memoryRefs: a missing memory dir is ok(empty) with a note; an unreadable one is unknown', rootOnly, () => {
  const dir = tmp('stacks-mem ');
  const missing = memoryRefs(stackSa, { dirs: [path.join(dir, 'nope')], exclude: [], platform: 'darwin' });
  assert.deepEqual(missing.ok && missing.value, []);
  assert.match(missing.notes.join(' '), /does not exist/);
  const locked = path.join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    assert.equal(memoryRefs(stackSa, { dirs: [locked], exclude: [], platform: 'darwin' }).ok, false);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.deepEqual(memoryRefs(stackSa, { dirs: [dir], exclude: [], platform: 'win32' }), { ok: false, reason: 'windows' });
});

// ---- resolveProbeBins ----
test('resolveProbeBins: defaults, and the PIPELINE_LSOF / PIPELINE_PS seams only for an isolated run in the checkout', posixOnly, () => {
  const home = tmp('stacks-home ');
  const checkout = tmp('stacks-root ');
  assert.deepEqual(resolveProbeBins({ env: {}, home, root: checkout }), { lsof: '/usr/sbin/lsof', ps: '/bin/ps' });
  const env = { PIPELINE_STACKS_HOME: tmp('stacks-state '), PIPELINE_STACKS_ONLY: 'x', PIPELINE_LSOF: '/fake/lsof', PIPELINE_PS: '/fake/ps' };
  assert.deepEqual(resolveProbeBins({ env, home, root: checkout }), { lsof: '/fake/lsof', ps: '/fake/ps' });
  const { PIPELINE_STACKS_ONLY: _drop, ...noOnly } = env;
  assert.deepEqual(resolveProbeBins({ env: noOnly, home, root: checkout }), { lsof: '/usr/sbin/lsof', ps: '/bin/ps' });
  const installed = tmp('stacks-installed ');
  writeFileSync(path.join(installed, 'INSTALLED.json'), '{}');
  assert.deepEqual(resolveProbeBins({ env, home, root: installed, warn: () => {} }), { lsof: '/usr/sbin/lsof', ps: '/bin/ps' });
});

// R1-B3: a process names the stack's port as `-p <port>`, `--port=<port>` or `PGPORT=<port>`, not only as `host:port`.
test('processRefs: -p / --port= / PGPORT= port references count (cmdline and environment)', () => {
  const cmdLines = [
    ' 5001   501 psql -h 127.0.0.1 -p 54422 postgres',
    ' 5002   501 node x',
    ' 5003   501 pg_dump --port=54422 postgres',
    ' 5004   501 psql -p 5442 postgres',
    ' 5005   501 psql -p 544220 postgres',
  ];
  const envLines = [
    ' 5001 psql -h 127.0.0.1 -p 54422 postgres HOME=/Users/me',
    ' 5002 node x HOME=/Users/me PGPORT=54422',
    ' 5003 pg_dump --port=54422 postgres HOME=/Users/me',
    ' 5004 psql -p 5442 postgres HOME=/Users/me',
    ' 5005 psql -p 544220 postgres HOME=/Users/me',
  ];
  const r = processRefs(stack, refOpts(psMachine({ cmdLines, envLines })));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((h) => h.pid), [5001, 5002, 5003]);
  assert.ok(r.value.every((h) => h.by === 'port'));
  assert.equal(r.value.find((h) => h.pid === 5002).field, 'env');
});

// R1-B2: only "gone" errors prove a consumer worktree is gone; any other stat failure is not an answer.
test('consumerWorktrees: a stat that fails with EACCES leaves exists unknown; prStates then answers unknown (stack listed)', () => {
  const { base } = makeRepo();
  const hidden = path.join(base, '.worktrees', 'hidden');
  const nowhere = path.join(base, '.worktrees', 'nowhere');
  const events = [{ kind: 'use', project: 'sa', worktree: hidden }, { kind: 'use', project: 'sa', worktree: nowhere }];
  const fsx = {
    ...fs,
    statSync: (p) => {
      if (p === hidden) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      if (p === nowhere) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return fs.statSync(p);
    },
  };
  const r = consumerWorktrees(stackSa, { events, repos: [], listWorktrees: () => [], fsx, platform: 'darwin' });
  assert.equal(r.ok, true);
  const byPath = Object.fromEntries(r.value.map((w) => [w.path, w]));
  assert.equal(byPath[nowhere].exists, false);
  assert.equal(byPath[hidden].exists, null);
  const w = prWorld({ nodes: [prNode({ state: 'OPEN' })] });
  const states = prStates([byPath[hidden]], { ...w, platform: 'darwin' });
  assert.equal(states.ok, false);
  assert.match(states.reason, /cannot tell whether .*hidden exists/);
  assert.equal(w.ghCalls.length + w.gitCalls.length, 0);
});
