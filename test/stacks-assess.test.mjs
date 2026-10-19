// assess.mjs: the shared "what is true of this stack right now" helpers. buildCurrent must come from a FRESH inventory plus the
// workdir's config.toml (so a re-pointed workdir or a restarted container shows up as a binding failure), and gatherEvidence must
// hand each verdict exactly the probes it asked for, fail closed (unknown) and read the ledger under its lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCurrent, cwdDirs, findStack, freshStack, gatherEvidence, ownPids, readLedgerLocked, summarizeEvidence, SESSION_END_PROBES, SWEEP_PROBES } from '../pipeline/lib/stacks/assess.mjs';
import { checkBinding, sessionEndVerdict } from '../pipeline/lib/stacks/decide.mjs';
import { appendEvent } from '../pipeline/lib/stacks/ledger.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';
import { acquire, release } from '../pipeline/lib/locks.mjs';

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
const clean = { connections: () => ok([]), processRefs: () => ok([]), cwdInside: () => ok([]), consumerWorktrees: () => ok([]) };

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
    putWorker(w, 'self.json', { pid: 4343 }); // no birth recorded (the hook wrote it first): the pid alone counts
    putWorker(w, '5050.json', { pid: 5050, birth: 60 }); // the pid now belongs to another process
    putWorker(w, '6060.json', { pid: 6060, birth: 70 }); // liveness cannot be told
    putWorker(w, 'broken.json', '{nope');
    putWorker(w, 'array.json', '[1]');
    putWorker(w, 'nopid.json', { pid: 'x' });
    putWorker(w, '7070.json.tmp', { pid: 7070 });
    const notes = [];
    const isAlive = (o) => (o.pid === 4242 ? ok(true) : o.pid === 5050 ? ok(false) : unknown('ps timed out'));
    const got = ownPids(w.root, { isAlive, notes });
    assert.deepEqual([...got].sort(), [4242, 4343]);
    assert.equal(notes.filter((n) => /broken\.json|array\.json|nopid\.json/.test(n)).length, 3);
    // an unreadable folder or file never throws
    assert.deepEqual([...ownPids(w.root, { readDir: () => { throw new Error('EACCES'); }, notes: [] })], []);
    assert.deepEqual([...ownPids(w.root, { readFile: () => { throw new Error('EACCES'); }, isAlive, notes: [] })], []);
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
