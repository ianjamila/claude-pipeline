// stopStack (act.mjs): the only mutating call is `supabase stop --workdir <realpath>`, made under the project lock after a
// full re-check and fresh gates. A scriptable "world" stands in for Docker and the Supabase CLI: it records every call, so
// each test can assert that nothing but the one stop argv was ever run and that docker was only asked questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopStack, stopArgs, FORBIDDEN, resolveSupabase } from '../pipeline/lib/stacks/act.mjs';
import { stackFiles, lockDirs, projectLockName } from '../pipeline/lib/stacks/paths.mjs';
import { tryAcquire, release } from '../pipeline/lib/locks.mjs';
import { fakeDocker, container } from './fixtures/fake-docker.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id'; // lock owner records never create ~/.claude/pipeline-state/machine-id

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const SUPA = '/fake/bin/supabase';
const DB_VOLUME = 'supabase_db_alpha';
const GEN = { id: 'dbid0001', startedAt: '2026-10-19T01:00:00.000000000Z' };

// A throwaway world: state root (config + mode apply), a real workdir on disk, a docker whose containers/volumes can change.
function makeWorld({ mode = 'apply', config = true, onStop } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-act-')));
  const root = join(base, 'state');
  mkdirSync(root, { recursive: true });
  const files = stackFiles(root);
  if (config) writeFileSync(files.config, '{}');
  writeFileSync(files.mode, JSON.stringify({ sessionEnd: mode, sweeper: mode, devServers: 'report' }));
  const workdir = join(base, 'alpha.stack');
  mkdirSync(join(workdir, 'supabase'), { recursive: true });
  writeFileSync(join(workdir, 'supabase', 'config.toml'), 'project_id = "alpha"\n');
  const w = {
    base, root, files, workdir, calls: [], supabaseCalls: [], logs: [],
    running: true, containerPresent: true, volumes: [DB_VOLUME, 'supabase_other_unrelated'],
    stopResult: { code: 0, stdout: '', stderr: '', timedOut: false, signal: null },
    onStop: onStop ?? ((x) => { x.containerPresent = false; }), // the Supabase CLI removes its containers on stop
  };
  w.stack = {
    project: 'alpha', workdir, workdirExists: true, folder: 'alpha.stack', shared: false, generation: GEN,
    containers: [], ports: [54322], volumes: [DB_VOLUME], dbVolume: DB_VOLUME,
  };
  w.current = () => ({
    workdirExists: true, workdirReal: workdir, labelWorkdirReal: workdir, configProject: 'alpha', labelProject: 'alpha',
    generation: GEN, shared: false,
  });
  w.run = (cmd, args = [], opts = {}) => {
    if (cmd === SUPA) {
      w.supabaseCalls.push([...args]);
      w.calls.push({ cmd, args: [...args], opts });
      if (w.stopResult.code === 0) w.onStop(w);
      return w.stopResult;
    }
    const d = fakeDocker({ inspect: w.containerPresent ? [container({ id: GEN.id, name: '/supabase_db_alpha', project: 'alpha', workdir, running: w.running })] : [], volumes: w.volumes });
    const r = d(cmd, args, opts);
    w.calls.push(...d.calls);
    return r;
  };
  w.reassess = async () => ({ verdict: 'stop', reasons: [], current: w.current() });
  w.stop = (over = {}) => stopStack({
    stack: w.stack, mode: 'apply', modeKey: 'sessionEnd', reassess: w.reassess, root, run: w.run, docker: 'docker', supabaseBin: SUPA,
    log: (rec) => w.logs.push(rec), lockWaitMs: 200, pollMs: 20, ...over,
  });
  w.cleanup = () => rmSync(base, { recursive: true, force: true });
  return w;
}

// Every test ends with these: docker was only asked questions, and every supabase argv is exactly stopArgs(workdir).
function assertSafe(w) {
  for (const c of w.calls) {
    if (c.cmd === SUPA) continue;
    assert.equal(c.cmd, 'docker');
    assert.ok(!c.args.includes('rm') && !c.args.includes('stop') && !(c.args[0] === 'volume' && c.args[1] === 'rm'), `forbidden docker call: ${c.args.join(' ')}`);
    assert.ok(['inspect', 'volume'].includes(c.args[0]) && (c.args[0] !== 'volume' || c.args[1] === 'inspect'), `unexpected docker call: ${c.args.join(' ')}`);
  }
  for (const argv of w.supabaseCalls) {
    assert.deepEqual(argv, stopArgs(w.workdir));
    for (const f of FORBIDDEN) assert.ok(!argv.includes(f), `${f} in argv`);
  }
}

async function check(w, over, fn) {
  try {
    const result = await w.stop(over);
    await fn(result);
    assertSafe(w);
  } finally {
    w.cleanup();
  }
}

test('stopArgs: the single argv, absolute workdir only', () => {
  assert.deepEqual(stopArgs('/work/a b/é.stack'), ['stop', '--workdir', '/work/a b/é.stack']);
  assert.deepEqual(stopArgs('C:\\work\\a'), ['stop', '--workdir', 'C:\\work\\a']);
  for (const bad of ['', '  ', '--all', 'relative/dir', null, undefined, '--project-id']) assert.throws(() => stopArgs(bad), /absolute workdir/);
  assert.deepEqual(FORBIDDEN, ['--all', '--no-backup', '--project-id']);
});

test('stops: one supabase call with exactly stopArgs; container gone after stop is fine; volume present', () => check(makeWorld(), {}, (r) => {
  assert.equal(r.action, 'stopped');
  assert.equal(r.alert, undefined);
  assert.deepEqual(r.post, { container: 'absent', dbVolume: DB_VOLUME, volumePresent: true });
}).then(() => {}));

test('stops: container kept but not running after stop is fine', async () => {
  const w = makeWorld({ onStop: (x) => { x.running = false; } });
  await check(w, {}, (r) => {
    assert.equal(r.action, 'stopped');
    assert.equal(r.post.container, 'stopped');
    assert.equal(w.supabaseCalls.length, 1);
  });
});

test('the decision is logged with project, generation, action and reasons', async () => {
  const w = makeWorld();
  await check(w, {}, () => {
    assert.equal(w.logs.length, 1);
    assert.equal(w.logs[0].project, 'alpha');
    assert.deepEqual(w.logs[0].generation, GEN);
    assert.equal(w.logs[0].action, 'stopped');
    assert.match(w.logs[0].t, /^\d{4}-\d\d-\d\dT.*Z$/);
  });
});

test('the project lock is held during the stop and released after', async () => {
  const w = makeWorld();
  let heldDuring = null;
  const dir = lockDirs(w.root).project;
  await check(w, { afterLock: () => { heldDuring = tryAcquire(projectLockName('alpha'), { dir }).acquired; } }, () => {
    assert.equal(heldDuring, false);
    const again = tryAcquire(projectLockName('alpha'), { dir });
    assert.equal(again.acquired, true);
    release(again.lock);
  });
});

test('an async log is finished while the project lock is still held (the next session sees the decision)', async () => {
  const w = makeWorld();
  const dir = lockDirs(w.root).project;
  const states = [];
  const slowLog = async (rec) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const probe = tryAcquire(projectLockName('alpha'), { dir });
    states.push({ action: rec.action, lockFreeAtWrite: probe.acquired });
    if (probe.acquired) release(probe.lock);
    w.logs.push(rec);
  };
  await check(w, { log: slowLog }, (r) => {
    assert.equal(r.action, 'stopped');
    assert.deepEqual(states, [{ action: 'stopped', lockFreeAtWrite: false }], 'the decision was written while the lock was held');
    assert.equal(w.logs.length, 1, 'stopStack answered only after the async log finished');
    const after = tryAcquire(projectLockName('alpha'), { dir });
    assert.equal(after.acquired, true);
    release(after.lock);
  });
});

test('an early return (no lock held) also waits for its async log; a rejecting log changes nothing', async () => {
  const w = makeWorld();
  let finished = false;
  const r = await w.stop({ reassess: undefined, log: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); finished = true; } });
  assert.equal(r.action, 'kept');
  assert.equal(finished, true);
  const rejected = await w.stop({ log: async () => { throw new Error('disk full'); } });
  assert.equal(rejected.action, 'stopped');
  assertSafe(w);
  w.cleanup();
});

test('mode report: would-stop, no supabase call', async () => {
  const w = makeWorld({ mode: 'report' });
  await check(w, { mode: 'report' }, (r) => {
    assert.equal(r.action, 'would-stop');
    assert.equal(w.supabaseCalls.length, 0);
    assert.equal(w.logs[0].action, 'would-stop');
  });
});

test('mode report but paused: the record says kept (paused), not would-stop', async () => {
  const w = makeWorld({ mode: 'report' });
  writeFileSync(w.files.pause, '');
  await check(w, { mode: 'report' }, (r) => {
    assert.equal(r.action, 'kept');
    assert.deepEqual(r.reasons, ['paused']);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('caller mode apply but mode.json says report at the start: kept (mode report)', async () => {
  const w = makeWorld({ mode: 'report' });
  await check(w, { mode: 'apply' }, (r) => {
    assert.equal(r.action, 'kept');
    assert.deepEqual(r.reasons, ['mode report']);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('mode key is per source: sweeper apply does not open sessionEnd', async () => {
  const w = makeWorld();
  writeFileSync(w.files.mode, JSON.stringify({ sessionEnd: 'report', sweeper: 'apply', devServers: 'apply' }));
  await check(w, { modeKey: 'sessionEnd' }, (r) => {
    assert.equal(r.action, 'kept');
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('re-check under the lock: a lease that appeared after the first assessment turns stop into kept', async () => {
  const w = makeWorld();
  await check(w, { reassess: async () => ({ verdict: 'kept', reasons: ['live lease from pid 9'], current: w.current() }) }, (r) => {
    assert.equal(r.action, 'kept');
    assert.deepEqual(r.reasons, ['live lease from pid 9']);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('re-check that throws or returns nothing keeps the stack', async () => {
  for (const reassess of [async () => { throw new Error('inventory exploded'); }, async () => undefined, async () => ({ verdict: 'stop', reasons: [] })]) {
    const w = makeWorld();
    await check(w, { reassess }, (r) => {
      assert.equal(r.action, 'kept');
      assert.equal(w.supabaseCalls.length, 0);
    });
  }
});

test('binding not ok keeps the stack: a different container id, a re-pointed workdir, a shared project', async () => {
  const cases = [
    (c) => ({ ...c, generation: { ...GEN, id: 'other' } }),
    (c) => ({ ...c, generation: { ...GEN, startedAt: '2026-10-19T09:00:00Z' } }),
    (c) => ({ ...c, labelWorkdirReal: '/elsewhere' }),
    (c) => ({ ...c, configProject: 'e2e-ci' }),
    (c) => ({ ...c, shared: true }),
  ];
  for (const mutate of cases) {
    const w = makeWorld();
    await check(w, { reassess: async () => ({ verdict: 'stop', reasons: [], current: mutate(w.current()) }) }, (r) => {
      assert.equal(r.action, 'kept');
      assert.ok(r.reasons.every((x) => x.startsWith('binding:')), r.reasons.join('; '));
      assert.equal(w.supabaseCalls.length, 0);
    });
  }
});

// R2-6: pause / config / mode are read again right before the call; flipping any of them after reassess blocks it.
const flips = {
  paused: [(w) => writeFileSync(w.files.pause, ''), 'paused'],
  'not configured': [(w) => rmSync(w.files.config), 'not configured'],
  'mode report': [(w) => writeFileSync(w.files.mode, JSON.stringify({ sessionEnd: 'report' })), 'mode report'],
};
for (const [name, [flip, reason]] of Object.entries(flips)) {
  test(`fresh gate: ${name} between reassess and the call => kept, no supabase call`, async () => {
    const w = makeWorld();
    await check(w, { beforeMutate: () => flip(w) }, (r) => {
      assert.equal(r.action, 'kept');
      assert.deepEqual(r.reasons, [reason]);
      assert.equal(w.supabaseCalls.length, 0);
    });
  });
}

test('machine config missing from the start: kept (not configured)', async () => {
  const w = makeWorld({ config: false });
  await check(w, {}, (r) => {
    assert.deepEqual([r.action, r.reasons], ['kept', ['not configured']]);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('db volume missing after the stop while an unrelated project volume remains => stopped with alert', async () => {
  const w = makeWorld({ onStop: (x) => { x.containerPresent = false; x.volumes = ['supabase_other_unrelated', 'supabase_db_alpha_old']; } });
  await check(w, {}, (r) => {
    assert.equal(r.action, 'stopped');
    assert.equal(r.alert, 'db-volume-missing');
    assert.equal(r.post.volumePresent, false);
    assert.equal(w.logs[0].alert, 'db-volume-missing');
  });
});

test('db volume unknown before the stop (null) => kept, no call', async () => {
  const w = makeWorld();
  w.stack.dbVolume = null;
  await check(w, {}, (r) => {
    assert.deepEqual([r.action, r.reasons], ['kept', ['db volume unknown']]);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('db volume unknown also keeps in report mode (it could not be stopped for real)', async () => {
  const w = makeWorld({ mode: 'report' });
  w.stack.dbVolume = null;
  await check(w, { mode: 'report' }, (r) => assert.equal(r.action, 'kept'));
});

test('the re-assessed db volume wins over the stale one', async () => {
  const w = makeWorld({ onStop: (x) => { x.containerPresent = false; x.volumes = ['vol_new']; } });
  await check(w, { reassess: async () => ({ verdict: 'stop', reasons: [], current: { ...w.current(), dbVolume: 'vol_new' } }) }, (r) => {
    assert.equal(r.post.dbVolume, 'vol_new');
    assert.equal(r.alert, undefined);
  });
});

test('container still running after a zero exit => failed, not stopped', async () => {
  const w = makeWorld({ onStop: () => {} });
  await check(w, {}, (r) => {
    assert.equal(r.action, 'failed');
    assert.match(r.reasons[0], /still running/);
    assert.equal(w.supabaseCalls.length, 1);
  });
});

test('post-check docker answers unknown => stopped with a post-check-unknown alert', async () => {
  const w = makeWorld();
  const run = (cmd, args, opts) => {
    if (cmd === SUPA) { w.supabaseCalls.push([...args]); w.calls.push({ cmd, args }); w.postStop = true; return w.stopResult; }
    if (w.postStop) return { code: 1, stdout: '', stderr: 'Cannot reach daemon??', timedOut: false, signal: null };
    return w.run(cmd, args, opts);
  };
  await check(w, { run }, (r) => {
    assert.equal(r.action, 'stopped');
    assert.equal(r.alert, 'post-check-unknown');
  });
});

test('workdir that does not exist => kept (report-only), no call', async () => {
  const w = makeWorld();
  rmSync(w.workdir, { recursive: true });
  await check(w, {}, (r) => {
    assert.equal(r.action, 'kept');
    assert.match(r.reasons.join(' '), /workdir does not exist/);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('Review Focus 4: supabase CLI error => failed with the first stderr line, called exactly once, no retry', async () => {
  const w = makeWorld();
  w.stopResult = { code: 1, stdout: '', stderr: 'Error: cannot stop: boom\nsecond line\n', timedOut: false, signal: null };
  await check(w, {}, (r) => {
    assert.equal(r.action, 'failed');
    assert.deepEqual(r.reasons, ['supabase stop failed: Error: cannot stop: boom']);
    assert.equal(w.supabaseCalls.length, 1);
  });
});

test('Review Focus 4: supabase binary missing (ENOENT text from run) => failed, called once', async () => {
  const w = makeWorld();
  w.stopResult = { code: 1, stdout: '', stderr: 'spawn /fake/bin/supabase ENOENT', timedOut: false, signal: null };
  await check(w, {}, (r) => {
    assert.equal(r.action, 'failed');
    assert.match(r.reasons[0], /ENOENT/);
    assert.equal(w.supabaseCalls.length, 1);
  });
});

test('supabase timeout or signal => failed; a throwing run => failed; no binary => failed with no call', async () => {
  for (const stopResult of [{ code: 124, stdout: '', stderr: '', timedOut: true, signal: 'SIGKILL' }, { code: 1, stdout: '', stderr: '', timedOut: false, signal: 'SIGTERM' }]) {
    const w = makeWorld();
    w.stopResult = stopResult;
    await check(w, {}, (r) => {
      assert.equal(r.action, 'failed');
      assert.equal(w.supabaseCalls.length, 1);
    });
  }
  const w = makeWorld();
  const run = (cmd, args, opts) => { if (cmd === SUPA) { w.supabaseCalls.push([...args]); throw new Error('spawn exploded'); } return w.run(cmd, args, opts); };
  await check(w, { run }, (r) => assert.match(r.reasons[0], /spawn exploded/));
  const n = makeWorld();
  await check(n, { supabaseBin: null }, (r) => {
    assert.deepEqual([r.action, r.reasons], ['failed', ['supabase binary not found']]);
    assert.equal(n.supabaseCalls.length, 0);
  });
});

test('container already not running at the re-check => already-stopped, no call', async () => {
  const w = makeWorld();
  w.running = false;
  await check(w, {}, (r) => {
    assert.equal(r.action, 'already-stopped');
    assert.equal(w.supabaseCalls.length, 0);
    assert.equal(w.logs[0].action, 'already-stopped');
  });
});

test('container gone (removed by an earlier stop) at the re-check => already-stopped, reassess not needed', async () => {
  const w = makeWorld();
  w.containerPresent = false;
  let reassessed = false;
  await check(w, { reassess: async () => { reassessed = true; return { verdict: 'kept', reasons: ['x'] }; } }, (r) => {
    assert.equal(r.action, 'already-stopped');
    assert.equal(reassessed, false);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('docker unknown at the re-check => kept', async () => {
  const w = makeWorld();
  const run = () => ({ code: 1, stdout: '', stderr: 'Cannot connect: weird', timedOut: false, signal: null });
  await check(w, { run }, (r) => {
    assert.equal(r.action, 'kept');
    assert.match(r.reasons[0], /container state unknown/);
    assert.equal(w.supabaseCalls.length, 0);
  });
});

test('two stops of one stack, one after the other: exactly one supabase call, the second is already-stopped', async () => {
  const w = makeWorld();
  try {
    const [a, b] = [await w.stop(), await w.stop()];
    assert.deepEqual([a.action, b.action], ['stopped', 'already-stopped']);
    assert.equal(w.supabaseCalls.length, 1);
    assertSafe(w);
  } finally {
    w.cleanup();
  }
});

test('lock not acquired in time (fake holder) => skipped-lock, no call', async () => {
  const w = makeWorld();
  const held = tryAcquire(projectLockName('alpha'), { dir: lockDirs(w.root).project });
  assert.equal(held.acquired, true);
  const t0 = Date.now();
  try {
    await check(w, { lockWaitMs: 150, pollMs: 20 }, (r) => {
      assert.equal(r.action, 'skipped-lock');
      assert.match(r.reasons[0], /project lock busy/);
      assert.equal(w.supabaseCalls.length, 0);
      assert.equal(w.calls.length, 0);
      assert.ok(Date.now() - t0 < 5000);
    });
  } finally {
    release(held.lock);
  }
});

test('the default lock wait is 60 s', async () => {
  const w = makeWorld();
  let waited = null;
  await check(w, { acquire: async (name, opts) => { waited = opts.waitMs; throw Object.assign(new Error('x'), { name: 'Error' }); }, lockWaitMs: undefined }, (r) => {
    assert.equal(waited, 60000);
    assert.equal(r.action, 'skipped-lock');
  });
});

test('project ids that look like global locks stop without waiting on them', async () => {
  for (const project of ['ledger', 'sweep', 'dev-3000']) {
    const w = makeWorld();
    w.stack.project = project;
    const cur = w.current;
    w.current = () => ({ ...cur(), configProject: project, labelProject: project });
    const globals = ['ledger', 'sweep'].map((n) => tryAcquire(n, { dir: lockDirs(w.root)[n] }));
    try {
      await check(w, { reassess: async () => ({ verdict: 'stop', reasons: [], current: w.current() }), lockWaitMs: 100 }, (r) => assert.equal(r.action, 'stopped'));
    } finally {
      for (const g of globals) if (g.acquired) release(g.lock);
    }
  }
});

test('a throwing log callback does not undo or hide the stop', async () => {
  const w = makeWorld();
  await check(w, { log: () => { throw new Error('disk full'); } }, (r) => {
    assert.equal(r.action, 'stopped');
    assert.equal(w.supabaseCalls.length, 1);
  });
});

test('no stack, no reassess, no root => kept without any call', async () => {
  const w = makeWorld();
  try {
    assert.equal((await stopStack({ stack: null, run: w.run })).action, 'kept');
    assert.equal((await w.stop({ reassess: undefined })).action, 'kept');
    assert.equal((await w.stop({ root: undefined })).action, 'kept');
    assert.equal(w.calls.length, 0);
  } finally {
    w.cleanup();
  }
});

test('resolveSupabase: seam honoured only for an isolated root; PATH then fallback dirs; bare name last', posixOnly, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-supa-')));
  try {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const exe = join(bin, 'supabase');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    const home = join(base, 'home');
    const warn = () => {};
    const iso = { PIPELINE_STACKS_HOME: join(base, 'iso'), PIPELINE_STACKS_ONLY: 'alpha', PIPELINE_SUPABASE: '/seam/supabase', PATH: bin };
    assert.equal(resolveSupabase({ env: iso, home, root: base, warn }), '/seam/supabase');
    // default root + ONLY: seam ignored, PATH wins
    assert.equal(resolveSupabase({ env: { ...iso, PIPELINE_STACKS_HOME: undefined }, home, root: base, warn }), exe);
    // installed copy: seam ignored
    writeFileSync(join(base, 'INSTALLED.json'), '{}');
    assert.equal(resolveSupabase({ env: iso, home, root: base, warn }), exe);
    rmSync(join(base, 'INSTALLED.json'));
    // not on PATH: fallback dir, then bare
    assert.equal(resolveSupabase({ env: { PATH: '' }, home, root: base, fallbackDirs: [bin] }), exe);
    assert.equal(resolveSupabase({ env: { PATH: '' }, home, root: base, fallbackDirs: [join(base, 'nope')] }), 'supabase');
    assert.equal(resolveSupabase({ env: iso, home, root: base, platform: 'win32', warn }), '/seam/supabase');
    assert.equal(resolveSupabase({ env: { PATH: bin }, home, root: base, platform: 'win32' }), 'supabase');
    assert.ok(existsSync(exe));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
