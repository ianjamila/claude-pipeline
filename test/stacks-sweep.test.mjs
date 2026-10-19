// The daily sweep (lib/stacks/sweep.mjs). Every dependency is injected: a clock, a scriptable Docker/Supabase "world" that records
// every call, the evidence probes and the worker/process lookups. The fixture reproduces the shape of the owner's real machine:
// e2e-ci / DRMed / eaglewatch-pipeline (shared), sa-corrections (consumer worktree with an OPEN PR), sub-detachments (live process
// references) and one fully orphaned stack. Nothing here reads the real home, Docker or ps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { mergeSettings, STACK_REGISTER_MATCHERS } from '../pipeline/lib/installer.mjs';
import { runSweep, hookHealth, cleanWorkers, ledgerUses, currentLeases, STACK_HOOKS } from '../pipeline/lib/stacks/sweep.mjs';
import { stopArgs } from '../pipeline/lib/stacks/act.mjs';
import { appendEvent } from '../pipeline/lib/stacks/ledger.mjs';
import { appendDecision, readDecisions } from '../pipeline/lib/stacks/outcomes.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';
import { acquire, release } from '../pipeline/lib/locks.mjs';
import { fakeDocker, container } from './fixtures/fake-docker.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const SUPA = '/fake/bin/supabase';
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const OLD = '2026-10-17T00:00:00.000000000Z'; // 60 h before T0: past the 24 h mark
const RECENT = '2026-10-19T10:00:00.000000000Z'; // 2 h before T0
const OWNER = { pid: 4101, birth: 1_792_000_000 };
const key = (o) => `${o.pid}:${o.birth}`;
const lowerOnly = (xs) => xs.map((x) => x.toLowerCase());

// ---- the machine ----------------------------------------------------------------------------------------------------------
function makeMachine({ mode = 'report', config = true, devPorts = [], extra = [] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-sweep-')));
  const root = join(base, 'state');
  mkdirSync(root, { recursive: true });
  const files = stackFiles(root);
  if (config) writeFileSync(files.config, JSON.stringify({ shared: ['e2e-ci', 'DRMed', 'eaglewatch-pipeline'], devPorts }));
  writeFileSync(files.mode, JSON.stringify({ sessionEnd: 'report', sweeper: mode, devServers: 'report' }));

  const dir = (name, project) => {
    const d = join(base, name);
    mkdirSync(join(d, 'supabase'), { recursive: true });
    writeFileSync(join(d, 'supabase', 'config.toml'), `project_id = "${project}"\n`);
    return d;
  };
  // shared first (as docker lists them), then the private ones
  const specs = [
    { project: 'DRMed', workdir: undefined, startedAt: OLD }, // the live DRMed stack has no workdir label
    { project: 'e2e-ci', workdir: dir('e2e.stack', 'e2e-ci'), startedAt: OLD },
    { project: 'eaglewatch-pipeline', workdir: dir('wt/.verify/supabase-workdir', 'eaglewatch-pipeline'), startedAt: OLD },
    { project: 'orphan-demo', workdir: dir('orphan.stack', 'orphan-demo'), startedAt: OLD },
    { project: 'sa-corrections', workdir: dir('sa.stack', 'sa-corrections'), startedAt: OLD },
    { project: 'sub-detachments', workdir: dir('sub.stack', 'sub-detachments'), startedAt: OLD },
    ...extra.map((e) => ({ ...e, workdir: e.workdir === undefined ? dir(`${e.project}.stack`, e.project) : e.workdir })),
  ].map((s, i) => ({ ...s, id: `dbid${String(i).padStart(4, '0')}`, port: String(54320 + i), removed: false }));

  const m = {
    base, root, files, specs, home: base, supabaseCalls: [], dockerCalls: [], alive: new Set(), consumers: {}, prs: {}, refs: {}, conns: {}, cwd: {},
    volumes: specs.map((s) => `supabase_db_${s.project}`), memory: [], transcripts: {},
  };
  m.spec = (project) => m.specs.find((s) => s.project === project);
  m.container = (s) => container({
    id: s.id, name: `/supabase_db_${s.project}`, project: s.project, workdir: s.workdir, startedAt: s.startedAt,
    ports: { '5432/tcp': [{ HostPort: s.port }] }, dbVolume: `supabase_db_${s.project}`,
  });
  m.run = (cmd, args = [], opts = {}) => {
    if (cmd === SUPA) {
      m.supabaseCalls.push([...args]);
      const hit = m.specs.find((s) => s.workdir === args[2]);
      if (hit && m.supabaseExit === undefined) hit.removed = true; // the Supabase CLI removes its containers on stop
      return { code: m.supabaseExit ?? 0, stdout: '', stderr: m.supabaseExit ? 'Error: failed to stop' : '', timedOut: false, signal: null, pid: 9 };
    }
    const live = m.specs.filter((s) => !s.removed);
    const d = fakeDocker({ ps: live.map((s) => s.id).join('\n'), inspect: live.map(m.container), volumes: m.volumes });
    const r = d(cmd, args, opts);
    m.dockerCalls.push(...d.calls);
    return r;
  };
  // evidence probes: quiet unless a test says otherwise
  m.evidence = {
    consumerWorktrees: (stack) => ok(m.consumers[stack.project] ?? [{ path: join(base, 'wt', `${stack.project}-gone`), exists: false }]),
    prStates: (wts) => ok(new Map(wts.map((w) => [w.path, m.prs[w.path] ?? { state: 'GONE', headMatches: true, eligible: true }]))),
    cwdInside: (dirs) => ok(m.cwd[dirs[0]] ?? []),
    connections: (stack) => ok(m.conns[stack.project] ?? []),
    processRefs: (stack) => ok(m.refs[stack.project] ?? []),
    memoryRefs: () => ok(m.memory),
    transcriptRefs: (stack) => ok(m.transcripts[stack.project] ?? []),
  };
  m.deps = (over = {}) => ({
    env: {}, platform: 'linux', home: base, root, files, now: () => T0, run: m.run, docker: 'docker', supabaseBin: SUPA, bins: { lsof: 'LSOF', ps: 'PS' },
    isAlive: (o) => ok(m.alive.has(key(o))), iso: { isDefault: false, only: null }, evidence: m.evidence, memoryOfProject: () => ok(2 * 1024 ** 3),
    procIdentity: () => ok({ pid: 1, birth: 1 }), lockWaitMs: 1500, lockPollMs: 10, ...over,
  });
  m.lease = (owner, project, over = {}) => appendEvent(files.ledger, { t: new Date(T0 - 3_600_000).toISOString(), kind: 'use', owner, project, workdir: m.spec(project)?.workdir, worktree: 'none', tool: 'Bash', via: 'test', ...over }, { lockDir: lockDirs(root).ledger });
  m.actions = () => (existsSync(files.actions) ? readFileSync(files.actions, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  m.sweep = (opts = {}, over = {}) => runSweep({ apply: Boolean(opts.apply), deps: m.deps(over) });
  m.cleanup = () => rmSync(base, { recursive: true, force: true });
  // today's machine: sa-corrections has a consumer worktree whose PR is OPEN; sub-detachments has live process references
  const saWt = join(base, 'wt', 'sa-correction-requests');
  m.consumers['sa-corrections'] = [{ path: saWt, exists: true }];
  m.prs[saWt] = { state: 'OPEN', headMatches: true, eligible: false };
  m.refs['sub-detachments'] = [{ pid: 5151, birth: 1_792_000_100, command: 'node /x/sub-detachments/server.js', field: 'cmdline', matched: 'sub-detachments', by: 'id' }];
  return m;
}

async function withMachine(opts, fn) {
  const m = makeMachine(opts);
  try {
    return await fn(m);
  } finally {
    m.cleanup();
  }
}

function assertSafeCalls(m) {
  for (const argv of m.supabaseCalls) {
    assert.equal(argv[0], 'stop');
    assert.equal(argv[1], '--workdir');
    assert.equal(argv.length, 3);
    for (const bad of ['--all', '--no-backup', '--project-id']) assert.ok(!argv.includes(bad));
  }
  for (const c of m.dockerCalls) assert.ok(!c.args.includes('rm') && !c.args.includes('stop') && !(c.args[0] === 'volume' && c.args[1] === 'rm'), `forbidden docker call ${c.args.join(' ')}`);
}

const names = (rows) => rows.map((r) => r.project).sort();

// ======================================================================= today's machine

test("today's machine, report mode: shared rows, sa-corrections and sub-detachments kept, the orphan would stop, ZERO supabase calls", async () => {
  await withMachine({}, async (m) => {
    const r = await m.sweep({ apply: false });
    assert.equal(r.ok, true);
    assert.deepEqual(lowerOnly(names(r.shared)), ['drmed', 'e2e-ci', 'eaglewatch-pipeline']);
    assert.deepEqual(names(r.kept), ['sa-corrections', 'sub-detachments']);
    assert.deepEqual(names(r.wouldStop), ['orphan-demo']);
    assert.deepEqual(r.stopped, []);
    assert.deepEqual(r.listed, []);
    assert.match(r.kept.find((k) => k.project === 'sa-corrections').reasons.join('\n'), /OPEN PR.*sa-correction-requests/);
    assert.match(r.kept.find((k) => k.project === 'sub-detachments').reasons.join('\n'), /processRefs: 1 process/);
    assert.equal(m.supabaseCalls.length, 0);
    assertSafeCalls(m);
    // shared stacks were never assessed: no decision about them, and no inspect of their containers beyond the inventory
    const dec = m.actions();
    assert.deepEqual(dec.map((d) => `${d.project}:${d.action}`).sort(), ['orphan-demo:would-stop', 'sa-corrections:kept', 'sub-detachments:kept']);
    assert.ok(dec.every((d) => d.source === 'sweep'));
    const wouldStop = dec.find((d) => d.action === 'would-stop');
    assert.equal(wouldStop.memBytes, 2 * 1024 ** 3);
    assert.equal(wouldStop.generation.id, m.spec('orphan-demo').id);
  });
});

test('the reports are written: report.md has the headlines, weekly-section.md the last 7 days; neither is a partial file', async () => {
  await withMachine({}, async (m) => {
    const r = await m.sweep({});
    assert.equal(r.report, m.files.report);
    const report = readFileSync(m.files.report, 'utf8');
    assert.match(report, /^# Stack stop report/);
    assert.match(report, /MISS 0 \(must be 0 to switch on\)/);
    assert.match(report, /GB freed 2\.00/);
    assert.match(report, /## Installed hook files/);
    assert.match(report, /stack-register\.mjs: .*not installed/); // nothing is installed under the fixture home
    const weekly = readFileSync(m.files.weekly, 'utf8');
    assert.match(weekly, /would-stops \/ stops: 1 \(0 stopped, 1 report-only\)/);
    assert.match(weekly, new RegExp(m.files.report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.summary, /3 shared, 2 kept, 0 listed, 1 would stop, 0 stopped/);
    assert.deepEqual(readdirSync(m.root).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(m.files.weekly.endsWith('weekly-section.md'), true);
  });
});

test('--apply with mode report: still ZERO supabase calls, the orphan is only recorded as a would-stop', async () => {
  await withMachine({ mode: 'report' }, async (m) => {
    const r = await m.sweep({ apply: true });
    assert.deepEqual(names(r.wouldStop), ['orphan-demo']);
    assert.deepEqual(r.stopped, []);
    assert.equal(m.supabaseCalls.length, 0);
    assert.ok(!m.specs.some((s) => s.removed));
  });
});

test('mode apply WITHOUT --apply is a dry run: zero supabase calls', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    const r = await m.sweep({ apply: false });
    assert.deepEqual(names(r.wouldStop), ['orphan-demo']);
    assert.equal(m.supabaseCalls.length, 0);
  });
});

test('--apply with mode apply: exactly one `supabase stop --workdir <realpath>`, for the orphan only', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    const r = await m.sweep({ apply: true });
    assert.deepEqual(names(r.stopped), ['orphan-demo']);
    assert.deepEqual(r.wouldStop, []);
    assert.deepEqual(names(r.kept), ['sa-corrections', 'sub-detachments']);
    assert.equal(m.supabaseCalls.length, 1);
    assert.deepEqual(m.supabaseCalls[0], stopArgs(m.spec('orphan-demo').workdir));
    assert.equal(m.supabaseCalls[0][2], realpathSync(m.spec('orphan-demo').workdir));
    assertSafeCalls(m);
    const stopped = m.actions().filter((d) => d.action === 'stopped');
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].project, 'orphan-demo');
    assert.equal(stopped[0].source, 'sweep');
    assert.equal(stopped[0].post.volumePresent, true);
    assert.match(r.summary, /1 stopped/);
    // the next day: the container is gone, so nothing is left to assess for it and no second call is made
    const again = await m.sweep({ apply: true });
    assert.equal(m.supabaseCalls.length, 1);
    assert.deepEqual(names(again.stopped), []);
  });
});

test('a pause file keeps every stack even with --apply and mode apply', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    writeFileSync(m.files.pause, '');
    const r = await m.sweep({ apply: true });
    assert.deepEqual(r.stopped, []);
    assert.deepEqual(names(r.kept), ['orphan-demo', 'sa-corrections', 'sub-detachments']);
    assert.match(r.kept.find((k) => k.project === 'orphan-demo').reasons.join('\n'), /paused/);
    assert.equal(m.supabaseCalls.length, 0);
    assert.match(readFileSync(m.files.report, 'utf8'), /PAUSED/);
  });
});

test('each evidence input flipped one at a time turns the orphan from would-stop into kept or listed', async () => {
  const cases = {
    'live lease': { kind: 'kept', set: async (m) => { m.alive.add(key(OWNER)); await m.lease(OWNER, 'orphan-demo'); } },
    'connection': { kind: 'kept', set: (m) => { m.conns['orphan-demo'] = [{ pid: null, birth: null, command: 'hidden client', port: 54323 }]; } },
    'process reference': { kind: 'kept', set: (m) => { m.refs['orphan-demo'] = [{ pid: 9, birth: 9, command: 'psql orphan-demo', field: 'cmdline' }]; } },
    'cwd process': { kind: 'kept', set: (m) => { m.evidence.cwdInside = () => ok([{ pid: 8, dir: m.spec('orphan-demo').workdir }]); } },
    'memory note': { kind: 'kept', set: (m) => { m.memory = ['/notes/x.md']; } },
    'recent transcript': { kind: 'kept', set: (m) => { m.transcripts['orphan-demo'] = ['/t/a.jsonl']; } },
    'keep list': { kind: 'kept', set: (m) => writeFileSync(m.files.keep, 'orphan-demo\n') },
    'uptime under 24 h': { kind: 'kept', set: (m) => { m.spec('orphan-demo').startedAt = RECENT; } },
    'consumer set empty': { kind: 'listed', set: (m) => { m.consumers['orphan-demo'] = []; } },
    'consumer without a PR': { kind: 'listed', set: (m) => { const p = join(m.base, 'wt', 'x'); m.consumers['orphan-demo'] = [{ path: p, exists: true }]; m.prs[p] = { state: 'NONE', headMatches: false }; } },
    'a probe is unknown': { kind: 'listed', set: (m) => { m.evidence.processRefs = () => unknown('ps timed out'); } },
    'workdir missing': { kind: 'listed', set: (m) => { rmSync(m.spec('orphan-demo').workdir, { recursive: true }); } },
  };
  for (const [name, c] of Object.entries(cases)) {
    await withMachine({ mode: 'apply' }, async (m) => {
      await c.set(m);
      const r = await m.sweep({ apply: true });
      assert.deepEqual(r.stopped, [], name);
      assert.deepEqual(r.wouldStop, [], name);
      assert.ok(names(r[c.kind]).includes('orphan-demo'), `${name}: expected ${c.kind}, got kept=${names(r.kept)} listed=${names(r.listed)}`);
      assert.equal(m.supabaseCalls.length, 0, name);
    });
  }
});

// ======================================================================= gates

test('config missing: "not configured", the report says so, ZERO decisions and zero docker/supabase calls', async () => {
  await withMachine({ config: false }, async (m) => {
    const r = await m.sweep({ apply: true });
    assert.equal(r.ok, true);
    assert.match(r.summary, /^not configured;/);
    assert.deepEqual([r.stopped, r.wouldStop, r.listed, r.kept, r.shared], [[], [], [], [], []]);
    assert.equal(existsSync(m.files.actions), false);
    assert.equal(m.dockerCalls.length + m.supabaseCalls.length, 0);
    assert.match(readFileSync(m.files.report, 'utf8'), /NOT CONFIGURED \(config\.json missing\)/);
  });
});

test('an invalid config is "not configured" too', async () => {
  await withMachine({}, async (m) => {
    writeFileSync(m.files.config, '{nope');
    const r = await m.sweep({ apply: true });
    assert.match(r.summary, /^not configured;/);
    assert.match(readFileSync(m.files.report, 'utf8'), /config\.json invalid/);
    assert.equal(m.actions().length, 0);
  });
});

test('a second sweep while one runs answers "already running" and touches nothing', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    const held = await acquire('sweep', { dir: lockDirs(m.root).sweep, waitMs: 1000 });
    try {
      const r = await m.sweep({ apply: true });
      assert.equal(r.ok, true);
      assert.equal(r.summary, 'already running');
      assert.equal(m.dockerCalls.length + m.supabaseCalls.length, 0);
      assert.equal(existsSync(m.files.actions), false);
    } finally {
      release(held);
    }
    const after = await m.sweep({});
    assert.notEqual(after.summary, 'already running', 'the lock is released after a run');
  });
});

test('two sweeps started together: one runs, one is "already running"; one supabase stop in total', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    const [a, b] = await Promise.all([m.sweep({ apply: true }), m.sweep({ apply: true })]);
    const summaries = [a.summary, b.summary];
    assert.equal(summaries.filter((s) => s === 'already running').length, 1, JSON.stringify(summaries));
    assert.equal(m.supabaseCalls.length, 1);
  });
});

test('a damaged ledger: every running private stack is LISTED "ledger damaged", zero stops even with --apply and mode apply', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    appendFileSync(m.files.ledger, 'this is not json\n');
    const r = await m.sweep({ apply: true });
    assert.equal(r.ok, true);
    assert.deepEqual(names(r.listed), ['orphan-demo', 'sa-corrections', 'sub-detachments']);
    for (const l of r.listed) assert.match(l.reasons.join(' '), /^ledger damaged: damaged ledger line 1/);
    assert.deepEqual(lowerOnly(names(r.shared)), ['drmed', 'e2e-ci', 'eaglewatch-pipeline']);
    assert.deepEqual([r.stopped, r.wouldStop, r.kept], [[], [], []]);
    assert.equal(m.supabaseCalls.length, 0);
    assert.equal(m.actions().length, 0, 'no decision is recorded about stacks that were not assessed');
    const report = readFileSync(m.files.report, 'utf8');
    assert.match(report, /## Ledger damaged/);
    assert.match(report, /P stacks repair/);
    assert.match(r.summary, /stopping disabled: ledger damaged/);
  });
});

test('a damaged decisions log also disables stopping (the numbers the owner switches on from would be wrong)', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    writeFileSync(m.files.actions, 'garbage\n');
    const r = await m.sweep({ apply: true });
    assert.deepEqual(names(r.listed), ['orphan-demo', 'sa-corrections', 'sub-detachments']);
    assert.match(r.listed[0].reasons[0], /^decisions log damaged/);
    assert.equal(m.supabaseCalls.length, 0);
  });
});

test('a lease appended between the assessment and the stop is seen under the lock: kept, no supabase call', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    m.alive.add(key(OWNER));
    const r = await m.sweep({ apply: true }, { afterLock: () => m.lease(OWNER, 'orphan-demo') });
    assert.deepEqual(r.stopped, []);
    assert.ok(names(r.kept).includes('orphan-demo'));
    assert.match(r.kept.find((k) => k.project === 'orphan-demo').reasons.join('\n'), /liveLeases: 1 live lease/);
    assert.equal(m.supabaseCalls.length, 0);
  });
});

test('a supabase stop that fails is `failed` (summary says FAILED), never retried', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    m.supabaseExit = 1;
    const r = await m.sweep({ apply: true });
    assert.equal(r.ok, true);
    assert.deepEqual(names(r.failed), ['orphan-demo']);
    assert.match(r.failed[0].reasons.join(' '), /supabase stop failed: Error: failed to stop/);
    assert.equal(m.supabaseCalls.length, 1);
    assert.match(r.summary, /1 FAILED/);
  });
});

test('docker down or an unreadable inventory: nothing assessed, the report is still written', async () => {
  await withMachine({}, async (m) => {
    const down = await m.sweep({}, { readInventory: () => ok({ dockerDown: true, stacks: [] }) });
    assert.match(down.summary, /^docker is not running;/);
    assert.ok(existsSync(m.files.report));
    const bad = await m.sweep({}, { readInventory: () => unknown('docker timed out') });
    assert.match(bad.summary, /^inventory unavailable;/);
    assert.match(bad.notes.join('\n'), /docker timed out/);
    assert.equal(m.actions().length, 0);
  });
});

test('Windows: not supported, nothing runs', async () => {
  const boom = () => { throw new Error('must not run on Windows'); };
  const r = await runSweep({ apply: true, deps: { platform: 'win32', run: boom, acquire: boom, now: boom } });
  assert.deepEqual(r, { ok: false, error: 'not supported on Windows' });
});

// ======================================================================= isolation

test('a non-default root without PIPELINE_STACKS_ONLY is refused; with it, only the listed projects are assessed', async () => {
  await withMachine({ mode: 'apply' }, async (m) => {
    const refusedRun = await runSweep({ apply: true, deps: { ...m.deps(), iso: undefined, env: { PIPELINE_STACKS_HOME: m.root } } });
    assert.equal(refusedRun.ok, false);
    assert.equal(refusedRun.error, 'isolation');
    assert.equal(m.dockerCalls.length, 0);

    const r = await m.sweep({ apply: true }, { iso: { isDefault: false, only: new Set(['sa-corrections', 'e2e-ci']) } });
    assert.deepEqual(names(r.kept), ['sa-corrections']);
    assert.deepEqual(lowerOnly(names(r.shared)), ['e2e-ci']);
    assert.deepEqual(r.stopped.concat(r.wouldStop), [], 'the orphan is outside the list: not assessed, not stopped');
    assert.equal(m.supabaseCalls.length, 0);
    assert.deepEqual(m.actions().map((d) => d.project), ['sa-corrections']);
  });
});

// ======================================================================= outcomes

test('a sweep that sees a C3 process, born before an open would-stop, records a use-observed and the report reads MISS 1', async () => {
  await withMachine({ mode: 'report' }, async (m) => {
    const orphan = m.spec('orphan-demo');
    const decidedAt = T0 - 30 * 60_000;
    await appendDecision(m.files.actions, {
      t: new Date(decidedAt).toISOString(), source: 'session-end', project: 'orphan-demo', generation: { id: orphan.id, startedAt: orphan.startedAt }, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {},
    });
    m.refs['orphan-demo'] = [{ pid: 777, birth: Math.floor((decidedAt - 3 * 3_600_000) / 1000), command: 'psql -h 127.0.0.1 orphan-demo', field: 'cmdline' }];
    const r = await m.sweep({});
    assert.ok(names(r.kept).includes('orphan-demo'));
    const used = m.actions().filter((d) => d.action === 'use-observed');
    assert.equal(used.length, 1);
    assert.deepEqual({ pid: used[0].use.pid, check: used[0].use.check, project: used[0].use.project }, { pid: 777, check: 'C3', project: 'orphan-demo' });
    assert.match(readFileSync(m.files.report, 'utf8'), /MISS 1 \(must be 0 to switch on\)/);
    assert.equal(r.outcomes.miss, 1);
    // seeing the same process again does not add another record
    await m.sweep({});
    assert.equal(m.actions().filter((d) => d.action === 'use-observed').length, 1);
  });
});

test('a use by a process born AFTER the would-stop is a RESTART; a hidden client is UNKNOWN (counts against switching on)', async () => {
  await withMachine({}, async (m) => {
    const orphan = m.spec('orphan-demo');
    const decidedAt = T0 - 30 * 60_000;
    await appendDecision(m.files.actions, {
      t: new Date(decidedAt).toISOString(), source: 'session-end', project: 'orphan-demo', generation: { id: orphan.id, startedAt: orphan.startedAt }, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {},
    });
    m.refs['orphan-demo'] = [{ pid: 778, birth: Math.floor((decidedAt + 60_000) / 1000), command: 'node app orphan-demo', field: 'cmdline' }];
    let r = await m.sweep({});
    assert.equal(r.outcomes.restart, 1);
    assert.equal(r.outcomes.miss, 0);
    m.conns['orphan-demo'] = [{ pid: null, birth: null, command: 'hidden client', port: 54323 }];
    r = await m.sweep({});
    assert.equal(r.outcomes.unknown, 1, 'the worst use of the decision is UNKNOWN');
    assert.match(readFileSync(m.files.report, 'utf8'), /MISS 0 \(\+1 unknown ⇒ not yet\)/);
  });
});

test('F1: a sweep charges a use to the NEWEST would-stop of a long-lived generation, and sees the same process again for the next record', async () => {
  await withMachine({ mode: 'report' }, async (m) => {
    const orphan = m.spec('orphan-demo');
    const gen = { id: orphan.id, startedAt: orphan.startedAt };
    const rec = (t, source = 'sweep') => appendDecision(m.files.actions, { t: new Date(t).toISOString(), source, project: 'orphan-demo', generation: gen, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {} });
    await rec(T0 - 2 * 86_400_000); // the first would-stop, two days ago: the generation has lived since
    await rec(T0 - 30 * 60_000, 'session-end'); // a repeat 30 min ago
    m.refs['orphan-demo'] = [{ pid: 777, birth: Math.floor((T0 - 5 * 86_400_000) / 1000), command: 'psql orphan-demo', field: 'cmdline' }];
    const r = await m.sweep({});
    assert.equal(m.actions().filter((d) => d.action === 'use-observed').length, 1, 'recorded against the repeat, not dropped for being 2 days after the first');
    assert.equal(r.outcomes.miss, 1);
    // later, a newer would-stop of the same generation: the same process still being there is a use of THAT record too
    await rec(T0 + 60 * 60_000);
    const later = await m.sweep({}, { now: () => T0 + 90 * 60_000 });
    assert.equal(m.actions().filter((d) => d.action === 'use-observed').length, 2, 'the same process, a new record: not "reported once ever"');
    assert.equal(later.outcomes.miss, 1, 'still one row for the generation');
    // and no third record for a third sweep inside the same window
    await m.sweep({}, { now: () => T0 + 100 * 60_000 });
    assert.equal(m.actions().filter((d) => d.action === 'use-observed').length, 2);
  });
});

test('a ledger lease after an open would-stop counts as a use, with the owner identity from the event', async () => {
  await withMachine({}, async (m) => {
    const orphan = m.spec('orphan-demo');
    const decidedAt = T0 - 90 * 60_000;
    await appendDecision(m.files.actions, {
      t: new Date(decidedAt).toISOString(), source: 'sweep', project: 'orphan-demo', generation: { id: orphan.id, startedAt: orphan.startedAt }, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {},
    });
    // the owner was born before the would-stop: a live consumer the checks missed
    await m.lease({ pid: 4200, birth: Math.floor((decidedAt - 3_600_000) / 1000) }, 'orphan-demo', { t: new Date(decidedAt + 10 * 60_000).toISOString() });
    const r = await m.sweep({});
    assert.equal(r.outcomes.miss, 1);
  });
});

test('worker files from earlier session-end workers: a use-observed record they wrote is part of the outcome numbers', async () => {
  await withMachine({}, async (m) => {
    const orphan = m.spec('orphan-demo');
    const decidedAt = T0 - 60 * 60_000;
    const gen = { id: orphan.id, startedAt: orphan.startedAt };
    await appendDecision(m.files.actions, { t: new Date(decidedAt).toISOString(), source: 'session-end', project: 'orphan-demo', generation: gen, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {} });
    await appendDecision(m.files.actions, {
      t: new Date(decidedAt + 600_000).toISOString(), source: 'session-end', project: 'orphan-demo', generation: gen, action: 'use-observed', reasons: ['C2'],
      use: { t: new Date(decidedAt + 600_000).toISOString(), project: 'orphan-demo', pid: 5, birth: Math.floor(decidedAt / 1000) - 100, check: 'C2' },
    });
    const r = await m.sweep({});
    assert.equal(r.outcomes.miss, 1);
    assert.ok(readDecisions(m.files.actions).ok);
  });
});

// ======================================================================= housekeeping

test('F2: a dead worker left in phase decided/observing gets an observation-lost marker per decided target (UNKNOWN, not CLEAN); a waiting one, a live one and a finished-and-removed one get none', async () => {
  await withMachine({}, async (m) => {
    const orphan = m.spec('orphan-demo');
    const gen = { id: orphan.id, startedAt: orphan.startedAt };
    const decidedAt = T0 - 3 * 3_600_000;
    await appendDecision(m.files.actions, { t: new Date(decidedAt).toISOString(), source: 'session-end', project: 'orphan-demo', generation: gen, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {} });
    mkdirSync(m.files.workers, { recursive: true });
    const put = (pid, body) => writeFileSync(join(m.files.workers, `${pid}.json`), JSON.stringify({ pid, ...body }));
    put(111, { phase: 'observing', decisions: 1, targets: [{ project: 'orphan-demo', generation: gen, t: new Date(decidedAt).toISOString() }] }); // died mid-probes
    put(222, { phase: 'waiting', decisions: 0 }); // died before deciding: nothing to lose
    put(333, { phase: 'observing', decisions: 1, targets: [{ project: 'other', generation: gen, t: 'x' }] }); // alive: still observing
    put(444, { phase: 'decided', decisions: 2 }); // an older-format file: no targets named
    const identity = (pid) => (pid === 333 ? ok({ pid, birth: 5 }) : ok(null));
    m.consumers['orphan-demo'] = m.consumers['sa-corrections']; // an OPEN PR keeps it today: the sweep adds no newer would-stop record of its own
    const r = await m.sweep({}, { procIdentity: identity });
    assert.deepEqual(r.workers, ['111.json', '222.json', '444.json']);
    const lost = m.actions().filter((d) => d.action === 'observation-lost');
    assert.equal(lost.length, 1);
    assert.deepEqual({ source: lost[0].source, project: lost[0].project, generation: lost[0].generation }, { source: 'sweep', project: 'orphan-demo', generation: gen });
    assert.equal(lost[0].decidedAt, new Date(decidedAt).toISOString(), 'R4-B1: the marker names the decision record whose observation was lost');
    assert.equal(r.outcomes.unknown, 1, 'the would-stop nobody finished observing is UNKNOWN');
    assert.equal(r.outcomes.clean, 0);
    assert.match(readFileSync(m.files.report, 'utf8'), /MISS 0 \(\+1 unknown ⇒ not yet\)/);
    // a second sweep does not duplicate the marker (the file is gone)
    await m.sweep({}, { procIdentity: identity });
    assert.equal(m.actions().filter((d) => d.action === 'observation-lost').length, 1);
  });
});

test('workers/<pid>.json: a dead pid is removed, a live one and an unknown one are kept, other names are ignored', async () => {
  await withMachine({}, async (m) => {
    mkdirSync(m.files.workers, { recursive: true });
    for (const n of ['111.json', '222.json', '333.json', 'self.json', '444.json.tmp']) writeFileSync(join(m.files.workers, n), '{}');
    const identity = (pid) => (pid === 111 ? ok(null) : pid === 222 ? ok({ pid, birth: 5 }) : unknown('ps timed out'));
    const r = await m.sweep({}, { procIdentity: identity });
    assert.deepEqual(r.workers, ['111.json']);
    assert.deepEqual(readdirSync(m.files.workers).sort(), ['222.json', '333.json', '444.json.tmp', 'self.json']);
  });
});

test('cleanWorkers: no workers folder is fine; an unreadable one is an error line, not a crash', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-workers-')));
  try {
    assert.deepEqual(cleanWorkers({ files: { workers: join(base, 'none') }, identity: () => { throw new Error('unused'); } }), { removed: [], kept: [], errors: [], lost: [] });
    writeFileSync(join(base, 'file'), 'x');
    const r = cleanWorkers({ files: { workers: join(base, 'file') } });
    assert.equal(r.errors.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ======================================================================= hook health

test('hookHealth: nothing installed reads as "not installed" for each stack hook; files present without a settings entry is named', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-hooks-')));
  try {
    let h = hookHealth({ home });
    assert.equal(h.length, STACK_HOOKS.length);
    for (const row of h) {
      assert.match(row.file, /\.claude[\\/]pipeline[\\/]hooks[\\/]stack-[a-z-]+\.mjs$/);
      assert.match(row.problem, /hook file missing \(not installed\); settings\.json is missing/);
    }
    const hooksDir = join(home, '.claude', 'pipeline', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    for (const n of STACK_HOOKS) writeFileSync(join(hooksDir, `${n}.mjs`), '// hook\n');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    h = hookHealth({ home });
    assert.equal(h.length, STACK_HOOKS.length);
    for (const row of h) assert.equal(row.problem, 'no entry in settings.json (not installed)');
    writeFileSync(join(home, '.claude', 'settings.json'), '{broken');
    assert.match(hookHealth({ home })[0].problem, /settings\.json is unreadable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The installer's own entries are what "healthy" means: hookHealth asks inspectHooks about <home>/.claude, the home install writes into.
test('hookHealth: a settings.json written by the installer is healthy; each broken stack-register matcher / hook is named', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-hooks-ok-')));
  try {
    const claude = join(home, '.claude');
    const hooksDir = join(claude, 'pipeline', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    for (const n of STACK_HOOKS) writeFileSync(join(hooksDir, `${n}.mjs`), '// hook\n');
    const installed = mergeSettings({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node ~/hb.mjs' }] }] } }, { home: claude });
    const put = (obj) => writeFileSync(join(claude, 'settings.json'), JSON.stringify(obj));
    put(installed);
    assert.deepEqual(hookHealth({ home }), [], 'exactly what install writes is healthy (a foreign SessionEnd entry beside it changes nothing)');

    for (const matcher of STACK_REGISTER_MATCHERS) {
      const broken = structuredClone(installed);
      broken.hooks.PreToolUse = broken.hooks.PreToolUse.filter((g) => g.matcher !== matcher || !g.hooks.some((h) => String(h.args?.at(-1)).endsWith('stack-register.mjs')));
      put(broken);
      const h = hookHealth({ home });
      assert.equal(h.length, 1, JSON.stringify(h));
      assert.match(h[0].file, /stack-register\.mjs$/);
      assert.ok(h[0].problem.includes(JSON.stringify(matcher)), h[0].problem);
    }

    const edited = structuredClone(installed);
    edited.hooks.SessionEnd.at(-1).hooks[0].timeout = 99;
    put(edited);
    const h2 = hookHealth({ home });
    assert.equal(h2.length, 1);
    assert.match(h2[0].file, /stack-session-end\.mjs$/);
    assert.match(h2[0].problem, /differs from what install writes/);

    const gone = structuredClone(installed);
    delete gone.hooks.PostToolUse;
    put(gone);
    assert.match(hookHealth({ home })[0].problem, /no entry in settings\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hookHealth reads only the injected home', () => {
  const seen = [];
  const fsx = { readFileSync: (p) => { seen.push(p); const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, statSync: (p) => { seen.push(p); throw new Error('gone'); } };
  hookHealth({ home: '/nowhere/home', fsx });
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((p) => p.startsWith(`${join('/nowhere', 'home')}${sep}`)), 'every path read is under the injected home');
});

// ======================================================================= leases

test('ledgerUses attributes events by project, else by the stack folder; currentLeases drops dead owners and marks unknown ones', () => {
  const stack = { project: 'alpha', workdir: '/w/alpha.stack', folder: 'alpha.stack' };
  const events = [
    { t: '2026-10-19T10:00:00.000Z', kind: 'use', owner: { pid: 1, birth: 10 }, project: 'alpha', via: 'Bash' },
    { t: '2026-10-19T11:00:00.000Z', kind: 'use', owner: { pid: 1, birth: 10 }, project: 'alpha', via: 'Bash' },
    { t: '2026-10-19T10:30:00.000Z', kind: 'use', owner: { pid: 2, birth: 20 }, project: null, workdir: '/w/alpha.stack', via: 'Read' },
    { t: '2026-10-19T10:30:00.000Z', kind: 'use', owner: { pid: 3, birth: 30 }, project: null, workdir: '/w/elsewhere', via: 'Read' },
    { t: '2026-10-19T10:30:00.000Z', kind: 'dev', owner: { pid: 4, birth: 40 } },
  ];
  const uses = ledgerUses(events, [stack]);
  assert.deepEqual(uses.map((u) => `${u.project}:${u.pid}`), ['alpha:1', 'alpha:1', 'alpha:2']);
  const isAlive = (o) => (o.pid === 1 ? ok(true) : o.pid === 2 ? unknown('ps timed out') : ok(false));
  const leases = currentLeases(events, { stacks: [stack], isAlive });
  assert.deepEqual(leases.map((l) => [l.project, l.owner.pid, l.alive, l.since, l.last]), [
    ['alpha', 1, true, '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z'],
    ['alpha', 2, null, '2026-10-19T10:30:00.000Z', '2026-10-19T10:30:00.000Z'],
  ]);
});

// ======================================================================= the feature's own processes

test('a sweep never records a registered session-end worker (or itself) as a use of a would-stop, and tells the probes to skip it', async () => {
  await withMachine({ mode: 'report' }, async (m) => {
    const orphan = m.spec('orphan-demo');
    const decidedAt = T0 - 30 * 60_000;
    await appendDecision(m.files.actions, {
      t: new Date(decidedAt).toISOString(), source: 'session-end', project: 'orphan-demo', generation: { id: orphan.id, startedAt: orphan.startedAt }, mode: 'report', action: 'would-stop', reasons: ['x'], evidence: {},
    });
    mkdirSync(m.files.workers, { recursive: true });
    writeFileSync(join(m.files.workers, '9001.json'), JSON.stringify({ pid: 9001, birth: 77, phase: 'observing' }));
    m.alive.add(key({ pid: 9001, birth: 77 }));
    const before = Math.floor((decidedAt - 3 * 3_600_000) / 1000);
    m.refs['orphan-demo'] = [
      { pid: 9001, birth: 77, command: 'node pipeline.mjs stacks session-end --owner 1:2', field: 'env' },
      { pid: process.pid, birth: before, command: 'node pipeline.mjs stacks sweep', field: 'env' },
      { pid: 777, birth: before, command: 'psql orphan-demo', field: 'cmdline' },
    ];
    m.conns['orphan-demo'] = [{ pid: 9001, birth: 77, command: 'node', port: 54323 }];
    let excluded;
    const processRefs = (stack, o) => { excluded = o.excludePids; return ok(m.refs[stack.project] ?? []); };
    const r = await m.sweep({}, { evidence: { ...m.evidence, processRefs } });
    assert.deepEqual(m.actions().filter((d) => d.action === 'use-observed').map((d) => d.use.pid), [777]);
    assert.equal(r.outcomes.miss, 1);
    assert.ok(excluded.has(9001) && excluded.has(process.pid));
  });
});
