// assess.mjs: the shared "what is true of this stack right now" helpers. buildCurrent must come from a FRESH inventory plus the
// workdir's config.toml (so a re-pointed workdir or a restarted container shows up as a binding failure), and gatherEvidence must
// hand each verdict exactly the probes it asked for, fail closed (unknown) and read the ledger under its lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCurrent, cwdDirs, findStack, freshStack, gatherEvidence, ownPids, readLedgerLocked, summarizeEvidence, SESSION_END_PROBES, SWEEP_PROBES } from '../pipeline/lib/stacks/assess.mjs';
import { checkBinding, sessionEndVerdict } from '../pipeline/lib/stacks/decide.mjs';
import { appendEvent } from '../pipeline/lib/stacks/ledger.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';
import { acquire, release } from '../pipeline/lib/locks.mjs';
import { scanLiveSessions } from '../pipeline/lib/worktree-prune/live-sessions.mjs';
import { addSession, aliveStarts } from './helpers/claude-sessions.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const GEN = { id: 'dbid0001', startedAt: '2026-10-19T01:00:00.000000000Z' };
const CFG = { status: 'ok', shared: new Set(['e2e-ci', 'drmed']), repos: [], memoryDirs: ['/m'], memoryExclude: ['x.md'], transcriptDirs: ['/t'], devPorts: [3000] };
const OWNER = { pid: 100, birth: 1000 };
const OTHER = { pid: 222, birth: 2000 };
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-assess-')));
  const root = join(base, 'state');
  mkdirSync(root, { recursive: true });
  const files = stackFiles(root);
  const workdir = join(base, 'alpha.stack');
  mkdirSync(join(workdir, 'supabase'), { recursive: true });
  writeFileSync(join(workdir, 'supabase', 'config.toml'), 'project_id = "alpha"\n');
  const stack = {
    project: 'alpha', workdir, workdirExists: true, folder: 'alpha.stack', shared: false, generation: GEN,
    containers: [{ id: GEN.id, name: 'supabase_db_alpha', running: true, startedAt: GEN.startedAt }],
    ports: [54322], volumes: ['vol'], dbVolume: 'vol',
  };
  return { base, root, files, workdir, stack, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const lease = (owner, over = {}) => ({ t: new Date(NOW - 60_000).toISOString(), kind: 'use', owner, project: 'alpha', worktree: 'none', tool: 'Bash', via: 't', ...over });
// `cleanReal` leaves openSessions to the real probe (fake config dirs); `clean` stubs it out like the other probes.
const cleanReal = { connections: () => ok([]), processRefs: () => ok([]), cwdInside: () => ok([]), consumerWorktrees: () => ok([]) };
const clean = { ...cleanReal, openSessions: () => ok([]) };

function ctxFor(w, over = {}) {
  return {
    root: w.root, files: w.files, cfg: CFG, run: () => { throw new Error('no process may run in this test'); }, docker: 'docker', bins: { lsof: 'LSOF', ps: 'PS' },
    platform: 'linux', now: () => NOW, home: w.base, isAlive: (o) => ok(o.pid === OWNER.pid || o.pid === OTHER.pid ? o.pid === OTHER.pid : false),
    evidence: clean, readInventory: () => ok({ dockerDown: false, stacks: [w.stack] }),
    ...over,
  };
}

// ---- buildCurrent ----

test('buildCurrent from a fresh inventory + config.toml agrees with the assessed stack (checkBinding ok)', () => {
  const w = world();
  try {
    const cur = buildCurrent(w.stack, w.stack, { cfg: CFG });
    assert.deepEqual(cur, {
      workdirExists: true, workdirReal: w.workdir, labelWorkdirReal: w.workdir, configProject: 'alpha', labelProject: 'alpha',
      generation: GEN, shared: false, dbVolume: 'vol',
    });
    assert.deepEqual(checkBinding(w.stack, cur), { ok: true, reasons: [] });
  } finally {
    w.cleanup();
  }
});

test('buildCurrent: every field that moves turns the binding to not ok', () => {
  const w = world();
  try {
    const cases = {
      'restarted container': (f) => ({ ...f, generation: { ...GEN, startedAt: '2026-10-19T09:00:00Z' } }),
      'different container id': (f) => ({ ...f, generation: { ...GEN, id: 'other' } }),
      'label project differs': (f) => ({ ...f, project: 'beta' }),
      'label workdir differs': (f) => ({ ...f, workdir: join(w.base, 'elsewhere') }),
      'label workdir missing': (f) => ({ ...f, workdir: null, workdirExists: false }),
      'containers gone': () => null,
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const fresh = mutate(w.stack);
      const r = checkBinding(w.stack, buildCurrent(w.stack, fresh, { cfg: CFG }));
      assert.equal(r.ok, false, name);
    }
  } finally {
    w.cleanup();
  }
});

test('buildCurrent: config.toml re-pointed at a shared project => shared and binding not ok', () => {
  const w = world();
  try {
    writeFileSync(join(w.workdir, 'supabase', 'config.toml'), 'project_id = "e2e-ci"\n');
    const cur = buildCurrent(w.stack, w.stack, { cfg: CFG });
    assert.equal(cur.configProject, 'e2e-ci');
    assert.equal(cur.shared, true);
    assert.equal(checkBinding(w.stack, cur).ok, false);
  } finally {
    w.cleanup();
  }
});

test('buildCurrent: the workdir is gone, config.toml unreadable, or its realpath moved', posixOnly, () => {
  const w = world();
  try {
    const gone = { ...w.stack, workdir: join(w.base, 'gone.stack') };
    const a = buildCurrent(gone, w.stack, { cfg: CFG });
    assert.equal(a.workdirExists, false);
    assert.equal(a.workdirReal, null);
    assert.equal(checkBinding(gone, a).ok, false);
    rmSync(join(w.workdir, 'supabase', 'config.toml'));
    assert.equal(buildCurrent(w.stack, w.stack, { cfg: CFG }).configProject, null);
    // the assessed path is now a symlink to somewhere else: its realpath differs from what was assessed
    const link = join(w.base, 'link.stack');
    symlinkSync(w.workdir, link);
    const viaLink = buildCurrent({ ...w.stack, workdir: link }, w.stack, { cfg: CFG });
    assert.equal(viaLink.workdirReal, w.workdir);
    assert.equal(checkBinding({ ...w.stack, workdir: link }, viaLink).ok, false);
  } finally {
    w.cleanup();
  }
});

test('buildCurrent: no fresh stack means sharing is unknown => shared (never stoppable)', () => {
  const w = world();
  try {
    const cur = buildCurrent(w.stack, null, { cfg: CFG });
    assert.equal(cur.shared, true);
    assert.equal(cur.generation, null);
    assert.equal(cur.labelProject, null);
  } finally {
    w.cleanup();
  }
});

test('buildCurrent: an inventory that marks the stack shared, or a shared workdir path, is shared', () => {
  const w = world();
  try {
    assert.equal(buildCurrent(w.stack, { ...w.stack, shared: true }, { cfg: CFG }).shared, true);
    const verify = join(w.base, '.verify', 'supabase-workdir');
    mkdirSync(join(verify, 'supabase'), { recursive: true });
    writeFileSync(join(verify, 'supabase', 'config.toml'), 'project_id = "alpha"\n');
    const s = { ...w.stack, workdir: verify };
    assert.equal(buildCurrent(s, s, { cfg: CFG }).shared, true);
  } finally {
    w.cleanup();
  }
});

// ---- freshStack / findStack ----

test('freshStack: finds the project case-insensitively in a new inventory; unknown inventory is unknown; gone is ok(null)', () => {
  const w = world();
  try {
    const inv = ok({ dockerDown: false, stacks: [w.stack] });
    const calls = [];
    const f = freshStack('ALPHA', { readInventory: (o) => { calls.push(o); return inv; }, docker: 'D', cfg: CFG });
    assert.equal(f.ok, true);
    assert.equal(f.value.fresh, w.stack);
    assert.equal(calls[0].docker, 'D');
    assert.equal(freshStack('beta', { readInventory: () => inv }).value.fresh, null);
    assert.equal(freshStack('alpha', { readInventory: () => unknown('docker timed out') }).ok, false);
    assert.equal(freshStack('alpha', { readInventory: () => ok({ dockerDown: true, stacks: [] }) }).value.dockerDown, true);
    assert.equal(findStack(inv.value, 'nope'), null);
  } finally {
    w.cleanup();
  }
});

// ---- readLedgerLocked ----

test('readLedgerLocked: a line another process is writing right now is not read as damage', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OWNER), { lockDir: lockDirs(w.root).ledger });
    const writer = await acquire('ledger', { dir: lockDirs(w.root).ledger, waitMs: 1000 });
    const whole = `${JSON.stringify(lease(OTHER))}\n`;
    appendFileSync(w.files.ledger, whole.slice(0, 20)); // torn: the writer is mid-line
    const pending = readLedgerLocked({ files: w.files, root: w.root, waitMs: 3000, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 80));
    appendFileSync(w.files.ledger, whole.slice(20));
    release(writer);
    const r = await pending;
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.value.length, 2);
  } finally {
    w.cleanup();
  }
});

test('readLedgerLocked: damage is unknown; a lock that never frees is unknown, bounded by waitMs', async () => {
  const w = world();
  try {
    writeFileSync(w.files.ledger, 'not json\n');
    const bad = await readLedgerLocked({ files: w.files, root: w.root });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /damaged ledger line 1/);
    const held = await acquire('ledger', { dir: lockDirs(w.root).ledger, waitMs: 1000 });
    const t0 = Date.now();
    const stuck = await readLedgerLocked({ files: w.files, root: w.root, waitMs: 120, pollMs: 10 });
    assert.equal(stuck.ok, false);
    assert.match(stuck.reason, /ledger lock unavailable/);
    assert.ok(Date.now() - t0 < 3000);
    release(held);
  } finally {
    w.cleanup();
  }
});

// ---- gatherEvidence: the session-end set ----

test('session-end evidence on a quiet machine => sessionEndVerdict stop; own leases are not "other"', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OWNER), { lockDir: lockDirs(w.root).ledger });
    const { evidence, current, fresh } = await gatherEvidence(w.stack, ctxFor(w), { probes: SESSION_END_PROBES, excludeOwner: OWNER });
    assert.equal(fresh, w.stack);
    assert.equal(current.configProject, 'alpha');
    assert.equal(evidence.paused, false);
    assert.equal(evidence.keep.ok, true);
    assert.equal(evidence.otherLiveLeases.ok, true);
    assert.equal(evidence.otherLiveLeases.value.size, 0);
    assert.equal(evidence.binding.ok, true);
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'stop', v.reasons.join('; '));
  } finally {
    w.cleanup();
  }
});

test('session-end evidence: another LIVE owner is kept and named; a dead one is ignored', async () => {
  const w = world();
  try {
    const dead = { pid: 333, birth: 3000 };
    for (const o of [OWNER, OTHER, dead]) await appendEvent(w.files.ledger, lease(o), { lockDir: lockDirs(w.root).ledger });
    const { evidence } = await gatherEvidence(w.stack, ctxFor(w), { probes: SESSION_END_PROBES, excludeOwner: OWNER });
    assert.deepEqual([...evidence.otherLiveLeases.value.keys()], ['222:2000']);
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'kept');
    assert.match(v.reasons.join('\n'), /otherLiveLeases: 1 live lease\(s\) \(pid 222\)/);
  } finally {
    w.cleanup();
  }
});

test('session-end evidence: connection, process reference, cwd process, keep list, pause each flip stop to kept', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OWNER), { lockDir: lockDirs(w.root).ledger });
    const flips = {
      connection: { over: { evidence: { ...clean, connections: () => ok([{ pid: 999, birth: 5, command: 'psql', port: 54322 }]) } }, want: /connections: 1/ },
      'hidden client': { over: { evidence: { ...clean, connections: () => ok([{ pid: null, birth: null, command: 'hidden client', port: 54322 }]) } }, want: /hidden client/ },
      'process ref': { over: { evidence: { ...clean, processRefs: () => ok([{ pid: 55, birth: 1, command: 'node seed.mjs --workdir alpha.stack', field: 'cmdline' }]) } }, want: /processRefs: 1/ },
      'cwd process': { over: { evidence: { ...clean, cwdInside: () => ok([{ pid: 66, birth: 1, dir: w.workdir }]) } }, want: /cwdProcs: 1/ },
      unknown: { over: { evidence: { ...clean, connections: () => unknown('lsof timed out') } }, want: /connections unknown: lsof timed out/ },
      'probe throws': { over: { evidence: { ...clean, processRefs: () => { throw new Error('ps exploded'); } } }, want: /processRefs unknown: probe failed: ps exploded/ },
    };
    for (const [name, { over, want }] of Object.entries(flips)) {
      const { evidence } = await gatherEvidence(w.stack, ctxFor(w, over), { probes: SESSION_END_PROBES, excludeOwner: OWNER });
      const v = sessionEndVerdict(evidence);
      assert.equal(v.verdict, 'kept', name);
      assert.match(v.reasons.join('\n'), want, name);
    }
    writeFileSync(w.files.keep, '# keep\nALPHA\n');
    let v = sessionEndVerdict((await gatherEvidence(w.stack, ctxFor(w), { probes: SESSION_END_PROBES, excludeOwner: OWNER })).evidence);
    assert.match(v.reasons.join('\n'), /keep: alpha is on the keep list/);
    rmSync(w.files.keep);
    writeFileSync(w.files.pause, '');
    v = sessionEndVerdict((await gatherEvidence(w.stack, ctxFor(w), { probes: SESSION_END_PROBES, excludeOwner: OWNER })).evidence);
    assert.match(v.reasons.join('\n'), /paused/);
  } finally {
    w.cleanup();
  }
});

test('session-end evidence: a damaged ledger makes the lease probe unknown and the verdict kept', async () => {
  const w = world();
  try {
    writeFileSync(w.files.ledger, `${JSON.stringify(lease(OWNER))}\ngarbage\n`);
    const { evidence } = await gatherEvidence(w.stack, ctxFor(w), { probes: SESSION_END_PROBES, excludeOwner: OWNER });
    assert.equal(evidence.otherLiveLeases.ok, false);
    assert.equal(evidence.cwdProcs.ok, false, 'cwd needs the consumer worktrees, which need the ledger');
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'kept');
    assert.match(v.reasons.join('\n'), /damaged ledger line 2/);
  } finally {
    w.cleanup();
  }
});

test('session-end evidence: a lease with no usable owner, or an isAlive that cannot tell, is unknown', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease({ pid: 'x' }), { lockDir: lockDirs(w.root).ledger });
    assert.equal((await gatherEvidence(w.stack, ctxFor(w), { probes: ['otherLiveLeases'], excludeOwner: OWNER })).evidence.otherLiveLeases.ok, false);
    const w2 = world();
    try {
      await appendEvent(w2.files.ledger, lease(OTHER), { lockDir: lockDirs(w2.root).ledger });
      const e = (await gatherEvidence(w2.stack, ctxFor(w2, { isAlive: () => unknown('ps timed out') }), { probes: ['otherLiveLeases'], excludeOwner: OWNER })).evidence;
      assert.equal(e.otherLiveLeases.ok, false);
      assert.match(e.otherLiveLeases.reason, /ps timed out/);
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

// ---- generic: which probes run ----

test('only the requested probes are run and present (absent => the verdict reads unknown)', async () => {
  const w = world();
  try {
    const seen = [];
    const spy = (name, value) => (...a) => { seen.push(name); return value; };
    const ctx = ctxFor(w, { evidence: { connections: spy('connections', ok([])), processRefs: spy('processRefs', ok([])), cwdInside: spy('cwdInside', ok([])), consumerWorktrees: spy('consumerWorktrees', ok([])) } });
    const { evidence, current } = await gatherEvidence(w.stack, ctx, { probes: ['connections', 'paused'] });
    assert.deepEqual(Object.keys(evidence).sort(), ['connections', 'paused', 'stack']);
    assert.deepEqual(seen, ['connections']);
    assert.equal(current, null, 'no binding requested => no inventory read, no current');
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'kept');
    assert.match(v.reasons.join('\n'), /otherLiveLeases unknown: no result/);
  } finally {
    w.cleanup();
  }
});

test('cwdProcs covers the stack folder plus every EXISTING consumer worktree, once', async () => {
  const w = world();
  try {
    let dirs;
    const consumers = ok([{ path: '/x/wt/a', exists: true }, { path: '/x/wt/gone', exists: false }, { path: w.workdir, exists: true }, { path: '/x/wt/b', exists: true }]);
    const ctx = ctxFor(w, { evidence: { ...clean, consumerWorktrees: () => consumers, cwdInside: (d) => { dirs = d; return ok([]); } } });
    await gatherEvidence(w.stack, ctx, { probes: ['cwdProcs'] });
    assert.deepEqual(dirs, [w.workdir, '/x/wt/a', '/x/wt/b']);
    assert.deepEqual(cwdDirs({ workdir: '' }, undefined), []);
  } finally {
    w.cleanup();
  }
});

test('cwdProcs: worktree "none" + cwd = the stack folder: the dirs are the folder (plus real worktrees), never an ancestor; broad dirs are dropped with a note', async () => {
  const w = world();
  try {
    let dirs;
    const home = '/Users/me';
    const consumers = ok([
      { path: '/', exists: true }, { path: '/Users', exists: true }, { path: home, exists: true }, { path: `${home}/`, exists: true },
      { path: `${home}/wt/a`, exists: true },
    ]);
    const ctx = ctxFor(w, { home, evidence: { ...clean, consumerWorktrees: () => consumers, cwdInside: (d) => { dirs = d; return ok([]); } } });
    const { evidence } = await gatherEvidence(w.stack, ctx, { probes: ['cwdProcs'] });
    assert.deepEqual(dirs, [w.workdir, `${home}/wt/a`], 'only the stack folder and the real worktree');
    assert.equal(evidence.cwdProcs.ok, true);
    assert.ok(evidence.cwdProcs.notes.some((n) => /too broad/.test(n) && n.includes(home)), 'a note says what was dropped');
    const direct = cwdDirs({ workdir: w.workdir }, [{ path: '/', exists: true }, { path: '/Users/me', exists: true }, { path: '/a/b', exists: true }, { path: '/a/b/c', exists: true }], { home });
    assert.deepEqual(direct, [w.workdir, '/a/b/c'], 'fewer than 3 segments or the home directory never counts');
  } finally {
    w.cleanup();
  }
});

test('consumer worktrees are asked with the ledger events, the config repos and a 24 h transcript window; unknown propagates', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OWNER, { worktree: '/wt/a' }), { lockDir: lockDirs(w.root).ledger });
    let args;
    const ctx = ctxFor(w, { cfg: { ...CFG, repos: ['/repo'] }, evidence: { ...clean, consumerWorktrees: (s, o) => { args = { s, o }; return ok([]); } } });
    await gatherEvidence(w.stack, ctx, { probes: ['consumers'] });
    assert.equal(args.o.events.length, 1);
    assert.deepEqual(args.o.repos, ['/repo']);
    assert.deepEqual(args.o.transcripts, { dirs: ['/t'], sinceMs: NOW - 24 * 3_600_000 });
    const bad = await gatherEvidence(w.stack, ctxFor(w, { evidence: { ...clean, consumerWorktrees: () => unknown('cannot list worktrees of /repo') } }), { probes: ['cwdProcs', 'prStates'] });
    assert.match(bad.evidence.cwdProcs.reason, /cannot list worktrees/);
    assert.match(bad.evidence.prStates.reason, /cannot list worktrees/);
  } finally {
    w.cleanup();
  }
});

test('sweep-side probes are available too: liveLeases (nobody excluded), prStates, uptimeMs, memory, transcripts', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OTHER), { lockDir: lockDirs(w.root).ledger });
    const ctx = ctxFor(w, {
      evidence: {
        ...clean,
        consumerWorktrees: () => ok([{ path: '/wt/a', exists: false }]),
        prStates: (c) => ok(new Map(c.map((x) => [x.path, { state: 'GONE', headMatches: true, eligible: true }]))),
        memoryRefs: (s, o) => ok([`mem:${o.dirs.join(',')}:${o.exclude.join(',')}`]),
        transcriptRefs: (s, o) => ok([`tr:${o.dirs.join(',')}:${o.sinceMs}`]),
      },
    });
    const { evidence } = await gatherEvidence(w.stack, ctx, { probes: SWEEP_PROBES });
    assert.equal(evidence.liveLeases.value.size, 1);
    assert.equal(evidence.prStates.value.get('/wt/a').state, 'GONE');
    assert.equal(evidence.uptimeMs, NOW - Date.parse(GEN.startedAt));
    assert.deepEqual(evidence.memory.value, ['mem:/m:x.md']);
    assert.deepEqual(evidence.transcripts.value, [`tr:/t:${NOW - 24 * 3_600_000}`]);
    const noStart = await gatherEvidence({ ...w.stack, generation: { id: 'x', startedAt: 'garbage' } }, ctxFor(w), { probes: ['uptimeMs'] });
    assert.equal(noStart.evidence.uptimeMs, undefined);
  } finally {
    w.cleanup();
  }
});

test('inventory unavailable: the binding is not proved (and the assessed stack is used for the rest)', async () => {
  const w = world();
  try {
    const ctx = ctxFor(w, { readInventory: () => unknown('docker timed out') });
    const { evidence, current, fresh } = await gatherEvidence(w.stack, ctx, { probes: ['binding', 'paused'] });
    assert.equal(current, null);
    assert.equal(fresh, null);
    assert.equal(evidence.binding.ok, false);
    assert.match(evidence.binding.reasons[0], /docker timed out/);
    assert.equal(evidence.stack, w.stack);
  } finally {
    w.cleanup();
  }
});

test('the probes get the worker pid excluded, the injected binaries and a deadline', async () => {
  const w = world();
  try {
    let got;
    const ctx = ctxFor(w, { evidence: { ...clean, processRefs: (s, o) => { got = o; return ok([]); } } });
    await gatherEvidence(w.stack, ctx, { probes: ['processRefs'], deadlineMs: 5000 });
    assert.ok(got.excludePids.has(process.pid));
    assert.equal(got.lsof, 'LSOF');
    assert.equal(got.ps, 'PS');
    assert.equal(got.deadlineAt, NOW + 5000);
    assert.equal(got.platform, 'linux');
  } finally {
    w.cleanup();
  }
});

test('summarizeEvidence is compact and names unknowns', async () => {
  const w = world();
  try {
    await appendEvent(w.files.ledger, lease(OTHER), { lockDir: lockDirs(w.root).ledger });
    const { evidence } = await gatherEvidence(w.stack, ctxFor(w, { evidence: { ...clean, connections: () => unknown('lsof timed out') } }), { probes: SESSION_END_PROBES, excludeOwner: OWNER });
    const s = summarizeEvidence(evidence, { notes: ['n1'] });
    assert.equal(s.otherLiveLeases, 1);
    assert.equal(s.processRefs, 0);
    assert.match(s.connections, /^unknown: lsof timed out/);
    assert.equal(s.keep, false);
    assert.equal(s.paused, false);
    assert.equal(s.binding, 'ok');
    assert.deepEqual(s.notes, ['n1']);
    assert.ok(JSON.stringify(s).length < 600);
  } finally {
    w.cleanup();
  }
});

// ---- the feature's own workers are never consumers ----

const putWorker = (w, name, body) => {
  mkdirSync(w.files.workers, { recursive: true });
  writeFileSync(join(w.files.workers, name), typeof body === 'string' ? body : JSON.stringify(body));
};

test('ownPids: pids from workers/*.json; a recorded birth must still match (a reused pid is not ours); junk is a note, never a failure', () => {
  const w = world();
  try {
    assert.deepEqual([...ownPids(w.root)], [], 'no workers folder is fine');
    putWorker(w, '4242.json', { pid: 4242, birth: 50, owner: OWNER, phase: 'waiting' });
    putWorker(w, 'self.json', { pid: 4343 }); // no birth recorded: not provably ours, so it stays visible (R1-B4)
    putWorker(w, '5050.json', { pid: 5050, birth: 60 }); // the pid now belongs to another process
    putWorker(w, '6060.json', { pid: 6060, birth: 70 }); // liveness cannot be told
    putWorker(w, 'broken.json', '{nope');
    putWorker(w, 'array.json', '[1]');
    putWorker(w, 'nopid.json', { pid: 'x' });
    putWorker(w, '7070.json.tmp', { pid: 7070 });
    const notes = [];
    const isAlive = (o) => (o.pid === 4242 ? ok(true) : o.pid === 5050 ? ok(false) : unknown('ps timed out'));
    const got = ownPids(w.root, { isAlive, notes });
    assert.deepEqual([...got].sort(), [4242]);
    assert.equal(notes.filter((n) => /broken\.json|array\.json|nopid\.json/.test(n)).length, 3);
    // an unreadable folder or file never throws
    assert.deepEqual([...ownPids(w.root, { readDir: () => { throw new Error('EACCES'); }, notes: [] })], []);
    assert.deepEqual([...ownPids(w.root, { readFile: () => { throw new Error('EACCES'); }, isAlive, notes: [] })], []);
  } finally {
    w.cleanup();
  }
});

// R1-B4: a worker file without a recorded birth does not hide its pid, even when the pid is alive.
test('gatherEvidence: a birthless worker file whose pid is alive is not excluded (the current process still is)', async () => {
  const w = world();
  try {
    putWorker(w, '4343.json', { pid: 4343 });
    putWorker(w, '4242.json', { pid: 4242, birth: 50 });
    const seen = {};
    const grab = (name) => (...a) => { seen[name] = a[a.length - 1].excludePids; return ok([]); };
    const evidence = { ...clean, connections: grab('connections'), processRefs: grab('processRefs'), cwdInside: grab('cwdInside') };
    await gatherEvidence(w.stack, ctxFor(w, { evidence, isAlive: () => ok(true) }), { probes: ['connections', 'processRefs', 'cwdProcs'] });
    for (const name of ['connections', 'processRefs', 'cwdInside']) {
      assert.ok(!seen[name].has(4343), `${name} still counts the birthless pid`);
      assert.ok(seen[name].has(4242) && seen[name].has(process.pid), `${name} excludes the verified worker and itself`);
    }
  } finally {
    w.cleanup();
  }
});

test('gatherEvidence: every probe excludes the registered workers (alive, birth-checked) and the current process', async () => {
  const w = world();
  try {
    putWorker(w, '4242.json', { pid: 4242, birth: 50 });
    putWorker(w, '5050.json', { pid: 5050, birth: 60 });
    const seen = {};
    const grab = (name) => (...a) => { seen[name] = a[a.length - 1].excludePids; return ok([]); };
    const evidence = { ...clean, connections: grab('connections'), processRefs: grab('processRefs'), cwdInside: grab('cwdInside') };
    const ctx = ctxFor(w, { evidence, isAlive: (o) => ok(o.pid === 4242) });
    await gatherEvidence(w.stack, ctx, { probes: ['connections', 'processRefs', 'cwdProcs'] });
    for (const name of ['connections', 'processRefs', 'cwdInside']) {
      assert.ok(seen[name].has(4242) && seen[name].has(process.pid), `${name} excludes the worker and itself`);
      assert.ok(!seen[name].has(5050), `${name} still counts a reused pid`);
    }
  } finally {
    w.cleanup();
  }
});

// ---- openSessions: the REAL scanner over a fake config dir (<base>/.claude); only its ps call is stubbed ----

function sessionWorld() {
  const w = world();
  w.wtA = join(w.base, 'wt', 'a');
  w.wtB = join(w.base, 'wt', 'b');
  for (const d of [w.wtA, w.wtB]) mkdirSync(d, { recursive: true });
  w.consumers = [{ path: w.wtA, exists: true }];
  // gather with the real openSessions probe. `alive`: the pids ps reports running; ctx: extra ctx; probes / gather: gatherEvidence options
  w.open = async (alive = [], { consumers = w.consumers, ctx: extra = {}, probes = ['openSessions'], gather = {}, startsOpts } = {}) => {
    const starts = aliveStarts(alive, startsOpts);
    const ctx = ctxFor(w, { env: {}, liveSessionStarts: starts, listWorktrees: () => [], evidence: { ...cleanReal, consumerWorktrees: () => ok(consumers) }, ...extra });
    const r = await gatherEvidence(w.stack, ctx, { probes, ...gather });
    return { ...r, starts, ctx };
  };
  return w;
}

test('openSessions is a probe of both verdicts, and the decisions log summarises it', () => {
  assert.ok(SESSION_END_PROBES.includes('openSessions') && SWEEP_PROBES.includes('openSessions'));
  assert.equal(summarizeEvidence({ openSessions: ok([{ id: 'a', pid: 1, dir: '/x' }]) }).openSessions, 1);
  assert.match(summarizeEvidence({ openSessions: unknown('records unreadable') }).openSessions, /^unknown: records unreadable/);
});

test('openSessions: nobody parked in the stack folder or a consumer worktree -> ok([]); a session elsewhere does not count', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.base, join(w.base, 'elsewhere')], ageHours: 48 });
    const { evidence } = await w.open([11]);
    assert.deepEqual(evidence.openSessions, { ok: true, value: [] });
  } finally {
    w.cleanup();
  }
});

test('openSessions: a session parked 48 h in a consumer worktree, and one in the stack folder, are hits (both far past the 24 h transcript window); both verdicts keep', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.base, w.wtA], ageHours: 48 });
    addSession(w.base, { pid: 12, sid: 'bbbbbbbb-2222', lines: [join(w.workdir, 'supabase')], ageHours: 72 });
    const { evidence } = await w.open([11, 12], { probes: SESSION_END_PROBES });
    assert.deepEqual(evidence.openSessions, ok([{ id: 'bbbbbbbb', pid: 12, dir: w.workdir }, { id: 'aaaaaaaa', pid: 11, dir: w.wtA }]));
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'kept');
    assert.match(v.reasons.join('\n'), /openSessions: 2 open Claude session\(s\).*session bbbbbbbb pid 12 in .*alpha\.stack; session aaaaaaaa pid 11 in .*wt\/a/);
  } finally {
    w.cleanup();
  }
});

test('openSessions: the ended owner\'s stale record is ignored; a pid reused by another process is ignored; a LIVE session that reused the owner\'s pid is counted (no owner filtering)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: OWNER.pid, sid: 'oooooooo-0000', lines: [w.wtA] }); // the exited owner's record
    const gone = await w.open([], { gather: { excludeOwner: OWNER } });
    assert.deepEqual(gone.evidence.openSessions, ok([]), 'pid dead: not counted');
    assert.equal(gone.starts.calls.length, 1, 'ps was asked, and the pid was not running');
    const reused = await w.open([OWNER.pid], { startsOpts: { startOf: { [OWNER.pid]: 'Fri Oct 30 01:00:00 2026' } }, gather: { excludeOwner: OWNER } });
    assert.deepEqual(reused.evidence.openSessions, ok([]), 'pid reused with another start time: not counted');
    // a NEW session that got the same pid (and so the same <pid>.json name) and really started at its own procStart
    addSession(w.base, { pid: OWNER.pid, sid: 'nnnnnnnn-1111', procStart: 'Fri Oct 30 01:00:00 2026', lines: [w.wtA] });
    const live = await w.open([OWNER.pid], { startsOpts: { startOf: { [OWNER.pid]: 'Fri Oct 30 01:00:00 2026' } }, gather: { excludeOwner: OWNER } });
    assert.deepEqual(live.evidence.openSessions, ok([{ id: 'nnnnnnnn', pid: OWNER.pid, dir: w.wtA }]));
  } finally {
    w.cleanup();
  }
});

test('openSessions: no Claude sessions folder at all -> ok([]) with a note (an extra signal, never a requirement)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    const { evidence } = await w.open([]);
    assert.deepEqual(evidence.openSessions, { ok: true, value: [], notes: ['open-session records unavailable (no Claude sessions folder found)'] });
    assert.equal(sessionEndVerdict({ ...evidence, stack: w.stack }).notes.some((n) => /^openSessions: open-session records unavailable/.test(n)), true);
  } finally {
    w.cleanup();
  }
});

test('openSessions: a record we cannot read is unknown with the scanner\'s reason (session-end keeps and says why)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.base] });
    addSession(w.base, { pid: 21, raw: '{ this is not json' });
    const { evidence } = await w.open([11], { probes: SESSION_END_PROBES });
    assert.equal(evidence.openSessions.ok, false);
    assert.match(evidence.openSessions.reason, /^open Claude sessions could not all be placed: session record .*21\.json is unreadable \(not JSON\)/);
    const v = sessionEndVerdict(evidence);
    assert.equal(v.verdict, 'kept');
    assert.ok(v.reasons.some((r) => r.startsWith('openSessions unknown: open Claude sessions could not all be placed: session record') && r.includes('21.json')), JSON.stringify(v.reasons));
  } finally {
    w.cleanup();
  }
});

test('openSessions: a transcript that cannot be read is unknown too', { skip: (WIN_OR_ROOT() && 'chmod 000 is not enforced here') }, async () => {
  const w = sessionWorld();
  try {
    const file = addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wtB] });
    chmodSync(file, 0);
    try {
      const { evidence } = await w.open([11]);
      assert.equal(evidence.openSessions.ok, false);
      assert.match(evidence.openSessions.reason, /open session aaaaaaaa pid 11: transcript unreadable \(EACCES\)/);
    } finally {
      chmodSync(file, 0o644);
    }
  } finally {
    w.cleanup();
  }
});

function WIN_OR_ROOT() {
  return process.platform === 'win32' || process.getuid?.() === 0;
}

test('openSessions: consumers unknown -> unknown (the scan is not even started)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wtA] });
    const ctx = ctxFor(w, { env: {}, liveSessionStarts: aliveStarts([11]), evidence: { ...cleanReal, consumerWorktrees: () => unknown('cannot list worktrees of /repo') }, scanLiveSessions: () => { throw new Error('no scan'); } });
    const { evidence } = await gatherEvidence(w.stack, ctx, { probes: ['openSessions'] });
    assert.deepEqual(evidence.openSessions, unknown('openSessions need the consumer worktrees: cannot list worktrees of /repo'));
  } finally {
    w.cleanup();
  }
});

test('openSessions: a too-broad consumer dir is left out (with a note), so a session under it does not keep the stack', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: ['/tmp/some/where'] });
    const { evidence } = await w.open([11], { consumers: [{ path: '/tmp', exists: true }, { path: w.wtA, exists: true }] });
    assert.equal(evidence.openSessions.ok, true);
    assert.deepEqual(evidence.openSessions.value, []);
    assert.ok(evidence.openSessions.notes.some((n) => /"\/tmp" left out of the cwd check: too broad/.test(n)), JSON.stringify(evidence.openSessions.notes));
  } finally {
    w.cleanup();
  }
});

test('openSessions: the probe can be replaced through ctx.evidence, and the scan through ctx.scanLiveSessions; both get the deadline, env and home', posixOnly, async () => {
  const w = sessionWorld();
  try {
    let args;
    const stub = await gatherEvidence(w.stack, ctxFor(w, { env: { X: '1' }, listWorktrees: () => [], evidence: { ...cleanReal, openSessions: (stack, consumers, opts) => { args = { stack, consumers, opts }; return ok([{ id: 'zzzzzzzz', pid: 9, dir: '/d' }]); } } }), { probes: ['openSessions'], deadlineMs: 7000 });
    assert.deepEqual(stub.evidence.openSessions, ok([{ id: 'zzzzzzzz', pid: 9, dir: '/d' }]));
    assert.equal(args.stack.project, 'alpha');
    assert.deepEqual(args.opts.env, { X: '1' });
    assert.equal(args.opts.home, w.base);
    assert.equal(args.opts.deadlineAt, NOW + 7000);
    let scanArgs;
    const { evidence } = await gatherEvidence(w.stack, ctxFor(w, { env: { Y: '2' }, listWorktrees: () => [], evidence: { ...cleanReal, consumerWorktrees: () => ok([]) }, scanLiveSessions: (o) => { scanArgs = o; return { available: true, sessions: [{ id: 'cccccccc', pid: 3, cwd: join(w.workdir, 'supabase') }], unplaced: [] }; } }), { probes: ['openSessions'], deadlineMs: 7000 });
    assert.deepEqual(evidence.openSessions, ok([{ id: 'cccccccc', pid: 3, dir: w.workdir }]));
    assert.equal(scanArgs.deadlineAt, NOW + 7000);
    assert.deepEqual(scanArgs.env, { Y: '2' });
    assert.equal(scanArgs.home, w.base);
    assert.equal(scanArgs.platform, 'linux');
    const thrown = await gatherEvidence(w.stack, ctxFor(w, { evidence: { ...cleanReal, openSessions: () => { throw new Error('boom'); } } }), { probes: ['openSessions'] });
    assert.match(thrown.evidence.openSessions.reason, /open-session probe failed: boom/);
  } finally {
    w.cleanup();
  }
});

test('openSessions deadline: out of time -> unknown without asking ps; the ps timeout is the time left', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wtA] });
    const late = await w.open([11], { gather: { deadlineMs: 0 } });
    assert.equal(late.evidence.openSessions.ok, false);
    assert.match(late.evidence.openSessions.reason, /could not all be placed: deadline reached before every open session was placed/);
    assert.equal(late.starts.calls.length, 0, 'ps was not run');
    const capped = await w.open([11], { gather: { deadlineMs: 8000 } });
    assert.equal(capped.starts.calls[0].opts.timeoutMs, 8000);
    assert.equal(capped.evidence.openSessions.ok, true);
  } finally {
    w.cleanup();
  }
});

test('openSessions: scanned once per gather call, never cached on ctx (a session that opens before the locked re-gather is seen by it)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    let scans = 0;
    const starts = aliveStarts([11]);
    const ctx = ctxFor(w, {
      env: {}, liveSessionStarts: starts, listWorktrees: () => [], evidence: { ...cleanReal, consumerWorktrees: () => ok(w.consumers) },
      scanLiveSessions: (o) => { scans += 1; return scanLiveSessions(o); },
    });
    addSession(w.base, { pid: 12, sid: 'bbbbbbbb-2222', lines: [w.base] }); // some other, dead, session so a sessions folder exists
    const first = await gatherEvidence(w.stack, ctx, { probes: SESSION_END_PROBES });
    assert.equal(scans, 1);
    assert.deepEqual(first.evidence.openSessions, ok([]));
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.wtA], ageHours: 30 });
    const again = await gatherEvidence(w.stack, ctx, { probes: SESSION_END_PROBES });
    assert.equal(scans, 2);
    assert.deepEqual(again.evidence.openSessions, ok([{ id: 'aaaaaaaa', pid: 11, dir: w.wtA }]));
  } finally {
    w.cleanup();
  }
});

test('openSessions: case rules follow ctx.platform (a session in a different-case folder: another folder on linux, the same on macOS)', posixOnly, async () => {
  const w = sessionWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.base, 'wt', 'A')] });
    const linux = await w.open([11], { ctx: { platform: 'linux' } });
    assert.deepEqual(linux.evidence.openSessions, ok([]));
    const mac = await w.open([11], { ctx: { platform: 'darwin' } });
    assert.deepEqual(mac.evidence.openSessions, ok([{ id: 'aaaaaaaa', pid: 11, dir: w.wtA }]));
  } finally {
    w.cleanup();
  }
});

// A nested git worktree under the stack folder works in its own folder, not in this stack's: it does not keep the stack unless it is a
// consumer of it (then the consumer entry keeps it). The folder itself and plain subfolders still keep. Unreadable list -> counts.
function nestedWorld() {
  const w = sessionWorld();
  w.nested = join(w.workdir, '.worktrees', 'x');
  mkdirSync(w.nested, { recursive: true });
  w.listed = [];
  w.listWorktrees = (root) => { w.listed.push(root); return [{ path: w.workdir }, { path: w.nested }, { path: w.wtA }, { path: '/elsewhere/other', bare: true }]; };
  return w;
}

test('openSessions (stack folder): a session in a nested worktree that is not a consumer does not count; one at the folder, or in a plain subfolder, does', posixOnly, async () => {
  const w = nestedWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [join(w.nested, 'app')], ageHours: 48 });
    const none = await w.open([11], { ctx: { listWorktrees: w.listWorktrees } });
    assert.deepEqual(none.evidence.openSessions, ok([]), 'it works in its own worktree');
    assert.deepEqual(w.listed, [w.workdir]);
    addSession(w.base, { pid: 12, sid: 'bbbbbbbb-2222', lines: [w.workdir] });
    w.listed.length = 0;
    const root = await w.open([11, 12], { ctx: { listWorktrees: w.listWorktrees } });
    assert.deepEqual(root.evidence.openSessions, ok([{ id: 'bbbbbbbb', pid: 12, dir: w.workdir }]));
    assert.deepEqual(w.listed, [w.workdir], 'only needed for the session that is below the folder');
    addSession(w.base, { pid: 13, sid: 'cccccccc-3333', lines: [join(w.workdir, 'supabase')] });
    const sub = await w.open([11, 13], { ctx: { listWorktrees: w.listWorktrees } });
    assert.deepEqual(sub.evidence.openSessions, ok([{ id: 'cccccccc', pid: 13, dir: w.workdir }]));
  } finally {
    w.cleanup();
  }
});

test('openSessions (stack folder): the same nested worktree DOES keep the stack when it is a consumer; a session at the folder alone never needs the worktree list', posixOnly, async () => {
  const w = nestedWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.nested] });
    const r = await w.open([11], { consumers: [{ path: w.nested, exists: true }], ctx: { listWorktrees: w.listWorktrees } });
    assert.equal(r.evidence.openSessions.ok, true);
    assert.deepEqual(r.evidence.openSessions.value.map((h) => [h.id, h.pid]), [['aaaaaaaa', 11]], 'kept (counted once, whichever folder names it)');
    const at = nestedWorld();
    try {
      addSession(at.base, { pid: 12, sid: 'bbbbbbbb-2222', lines: [at.workdir] });
      const hit = await at.open([12], { ctx: { listWorktrees: () => { throw new Error('not needed'); } } });
      assert.deepEqual(hit.evidence.openSessions, ok([{ id: 'bbbbbbbb', pid: 12, dir: at.workdir }]));
    } finally {
      at.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('openSessions (stack folder): a session whose transcripts disagree (one copy inside the nested worktree, one at the folder) still counts; an unreadable worktree list counts everything, with a note', posixOnly, async () => {
  const w = nestedWorld();
  try {
    addSession(w.base, { pid: 11, sid: 'aaaaaaaa-1111', lines: [w.nested] });
    addSession(w.base, { config: '.claude-b', pid: 11, sid: 'aaaaaaaa-1111', lines: [w.workdir] });
    const both = await w.open([11], { ctx: { listWorktrees: w.listWorktrees } });
    assert.deepEqual(both.evidence.openSessions, ok([{ id: 'aaaaaaaa', pid: 11, dir: w.workdir }]));
    const w2 = nestedWorld();
    try {
      addSession(w2.base, { pid: 12, sid: 'bbbbbbbb-2222', lines: [w2.nested] });
      const r = await w2.open([12], { ctx: { listWorktrees: () => { throw new Error('not a git repository'); } } });
      assert.equal(r.evidence.openSessions.ok, true);
      assert.deepEqual(r.evidence.openSessions.value, [{ id: 'bbbbbbbb', pid: 12, dir: w2.workdir }]);
      assert.ok(r.evidence.openSessions.notes.some((n) => /could not be listed \(not a git repository\): every open session inside it counts/.test(n)));
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});
