// `pipeline ci-wait` state machine (lib/ci-wait.mjs), replayed against a simulated clock: nothing sleeps and nothing calls
// GitHub. The fixtures in test/fixtures/ci-wait/ are CAPTURED shapes from ianjamila/eaglewatch (check runs, statuses, a real
// same-suite re-run, branch protection, the PR 1631 draft-era race), trimmed and with URLs scrubbed. The ruleset sample at
// the bottom is synthetic: EW has no ruleset, so its shape is GitHub's documented one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APP_BOTS, MAX_READ_FAILURES, waitForCi } from '../pipeline/lib/ci-wait.mjs';
import { readClassicRequired, requiredFromRules } from '../pipeline/lib/protection.mjs';

const fxDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ci-wait');
const fx = (name) => JSON.parse(readFileSync(join(fxDir, name), 'utf8'));

const HEAD = 'a'.repeat(40);
const PR = { head: HEAD, isDraft: false, createdAt: '2026-01-01T00:00:00Z', base: 'main' };

// A world is described by values or by functions of the simulated seconds since the command started.
const at = (v, t, n) => (typeof v === 'function' ? v(t, n) : v);

function sim(world, options = {}) {
  let t = 0;
  const calls = [];
  const reads = { classic: [], rules: [], statuses: 0, checkRuns: 0, headRuns: [] }; // the base each policy read asked for
  const readers = {
    pr: async () => at(world.pr ?? PR, t / 1000),
    classic: async (base) => {
      reads.classic.push(base);
      return at(world.classic, t / 1000);
    },
    rules: async (base) => {
      reads.rules.push(base);
      return at(world.rules ?? [], t / 1000);
    },
    checkRuns: async () => {
      reads.checkRuns += 1;
      return at(world.checkRuns ?? [], t / 1000, reads.checkRuns);
    },
    statuses: async () => {
      reads.statuses += 1;
      return at(world.statuses ?? [], t / 1000, reads.statuses);
    },
    headRuns: async (head) => {
      reads.headRuns.push(head);
      return at(world.headRuns ?? [], t / 1000);
    },
    timeline: async () => at(world.timeline ?? [], t / 1000),
    suiteRuns: async (id) => {
      calls.push(id);
      return at(world.suiteRuns ?? (() => () => []), t / 1000)(id);
    },
  };
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const progress = [];
  const opts = { appearTimeoutMs: 300_000, timeoutMs: 3_600_000, intervalMs: 15_000, waitAll: false, configChecks: [], ...options };
  return {
    run: () => waitForCi({ readers, options: opts, clock, onProgress: (l) => progress.push(l) }),
    elapsed: () => t,
    progress,
    suiteCalls: calls,
    reads,
  };
}

const present = (...rows) => ({ kind: 'present', rows: rows.map((r) => (typeof r === 'string' ? { context: r, appId: null } : r)) });
const pin = (context, appId) => ({ context, appId });
const ACTIONS = 15368;
let seq = 1000;
const cr = (name, conclusion, over = {}) => ({
  id: ++seq, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, app: { id: ACTIONS }, check_suite: { id: 1 }, html_url: `https://github.example/runs/${seq}`, ...over,
});
const st = (context, state, login = 'github-actions[bot]', over = {}) => ({ id: ++seq, context, state, creator: { login }, created_at: '2026-01-01T00:00:00Z', ...over });

// ---- the Phase 6 race, on the captured PR 1631 shapes -------------------------------------------

// EW main's real protection. On the real PR 1631 the `Cross-model review` status was a draft-era FAILURE (08:38:49) until the
// ready run re-posted it as a success (08:42:55): that failure must not end the wait either.
function raceClassic() {
  return readClassicRequired({ protection: () => ({ status: 200, json: fx('protection-main.json') }) }, 'main');
}

test('the Phase 6 race: a draft-era SKIPPED Typecheck + Vitest keeps the wait open until the ready run passes', async () => {
  const readyAt = Date.parse('2026-11-04T08:42:27Z');
  const runs = fx('check-runs-race.json');
  const typecheck = 126485522095;
  const statuses = fx('statuses-race.json');
  const world = {
    pr: { head: '5fab86f7900856ea23faf1fb88e68ebdd603bd02', isDraft: false, createdAt: '2026-11-04T08:32:39Z', base: 'main' },
    classic: raceClassic(),
    timeline: fx('timeline-race.json'),
    suiteRuns: () => (id) => fx('workflow-runs-by-suite.json')[id] ?? [],
    checkRuns: (t) => {
      if (t < 30) return runs.filter((r) => Date.parse(r.started_at) < readyAt); // only the draft-era runs exist
      return runs.map((r) => (r.id === typecheck && t < 60 ? { ...r, status: 'in_progress', conclusion: null, completed_at: null } : r));
    },
    statuses: (t) => {
      if (t < 30) return statuses.filter((s) => Date.parse(s.created_at) <= readyAt);
      if (t < 45) return statuses.filter((s) => Date.parse(s.created_at) < Date.parse('2026-11-04T08:42:40Z')); // guards re-posted as pending
      return statuses;
    },
  };
  const s = sim(world);
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 60_000, 'not before the ready-era Typecheck + Vitest run passed (poll 5), not at poll 1 on the skip');
  assert.equal(r.output.readyAt, '2026-11-04T08:42:27Z');
  assert.deepEqual(r.output.requiredSource, { classic: 'present', rules: 'absent' });
  const states = Object.fromEntries(r.output.checks.map((c) => [c.name, c.state]));
  assert.deepEqual(states, { 'Typecheck + Vitest': 'pass', 'Static guards': 'pass', Vercel: 'pass', 'Test integrity': 'pass', 'Hard-stop scan': 'pass', 'Cross-model review': 'pass' });
  assert.ok(s.progress.some((l) => /Cross-model review=stale-fail/.test(l)), 'the draft-era failure was waited on, not reported');
  assert.ok(s.progress.some((l) => /Typecheck \+ Vitest=stale-skip/.test(l)), s.progress.join(' | '));
  // the draft-era skip was judged by its workflow run, once (cached per suite)
  assert.deepEqual(s.suiteCalls, [113268557037]);
});

// ---- a needs:-gated aggregate appears late by design: ready-era runs still going keep the wait open (#159) ------------------

// A world where the required aggregate `Typecheck + Vitest` has only a draft-era skip until `appearAt` seconds, while a shard job
// of the ready-event workflow run (suite 7, created after the ready event) is in_progress until `shardDoneAt`.
function lateAggregate({ appearAt, shardDoneAt = appearAt, shardSuiteCreated = '2026-01-01T12:00:05Z', skipOnly = true } = {}) {
  const aggregate = cr('Typecheck + Vitest', 'success', { check_suite: { id: 7 } });
  return {
    classic: present('Typecheck + Vitest'),
    timeline: readyTimeline,
    checkRuns: (t) => [
      ...(skipOnly ? [cr('Typecheck + Vitest', 'skipped', { id: 1, check_suite: { id: 3 } })] : []),
      cr('Typecheck + Vitest (shard 1/2)', t < shardDoneAt ? null : 'success', { id: 5, check_suite: { id: 7 } }),
      ...(t >= appearAt ? [aggregate] : []),
    ],
    suiteRuns: () => (id) => [{ created_at: id === 7 ? shardSuiteCreated : '2026-01-01T11:00:00Z' }],
  };
}

test('a stale-skipped aggregate keeps waiting past the appear window while a ready-era run is in progress, then passes when it appears', async () => {
  const s = sim(lateAggregate({ appearAt: 600 }));
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 600_000, 'not at the 300s appear deadline');
  assert.equal(r.output.heldBy.kind, 'check-run');
  assert.equal(r.output.heldBy.name, 'Typecheck + Vitest (shard 1/2)');
  assert.equal(r.output.heldBy.status, 'in_progress');
  assert.ok(s.progress.some((l) => /still running/.test(l) && /shard 1\/2/.test(l)), s.progress.join(' | '));
});

test('the same wait on a MISSING aggregate (no draft-era skip either) is held by an in-progress ready-era workflow run', async () => {
  const aggregate = cr('Typecheck + Vitest', 'success', { check_suite: { id: 7 } });
  // only the workflow run is visible (no check run of it yet): it is read from the head's workflow runs
  const s = sim({
    classic: present('Typecheck + Vitest'), timeline: readyTimeline,
    checkRuns: (t) => (t >= 705 ? [aggregate] : []),
    headRuns: (t) => (t < 705 ? [{ id: 55, name: 'CI', status: 'queued', created_at: '2026-01-01T12:00:05Z', html_url: 'https://github.example/actions/55' }] : []),
  });
  const r = await s.run();
  assert.equal(r.output.verdict, 'passed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 705_000);
  assert.deepEqual(r.output.heldBy, { kind: 'workflow-run', id: 55, name: 'CI', status: 'queued', createdAt: '2026-01-01T12:00:05Z', url: 'https://github.example/actions/55', predatesReady: false });
});

test('with nothing ready-era running, the appear deadline ends the wait with the old verdicts (stale-skipped / missing)', async () => {
  const skip = sim(lateAggregate({ appearAt: 99999, shardDoneAt: 0 }));
  const a = await skip.run();
  assert.equal(a.output.verdict, 'stale-skipped');
  assert.equal(skip.elapsed(), 300_000);
  assert.equal(a.output.heldBy, undefined);
  const missing = sim({ classic: present('ci'), timeline: readyTimeline, headRuns: [{ id: 9, name: 'Other', status: 'completed', created_at: '2026-01-01T12:00:05Z' }] });
  const b = await missing.run();
  assert.equal(b.output.verdict, 'missing');
  assert.equal(missing.elapsed(), 300_000);
});

test('an in-progress run created BEFORE the ready event does not hold a stale-skip, but does hold a MISSING identity (timeout, not missing)', async () => {
  const draftEra = sim(lateAggregate({ appearAt: 99999, shardSuiteCreated: '2026-01-01T11:30:00Z' }));
  const a = await draftEra.run();
  assert.equal(a.output.verdict, 'stale-skipped');
  assert.equal(draftEra.elapsed(), 300_000);
  // spec change (2026-11-09 plan B), not a loosening: a MISSING identity is now held by a pre-ready run that could produce it (the stale-skip half above is unchanged)
  const wf = sim({ classic: present('ci'), timeline: readyTimeline, headRuns: [{ id: 9, name: 'Old', status: 'in_progress', created_at: '2026-01-01T11:59:59Z' }] }, { timeoutMs: 900_000 });
  const b = await wf.run();
  assert.equal(b.output.verdict, 'timeout');
  assert.equal(wf.elapsed(), 900_000);
  assert.equal(b.output.heldBy.predatesReady, true);
});

test('an in-progress ready-era run only extends the wait up to the overall --timeout (verdict `timeout`, heldBy reported)', async () => {
  const s = sim(lateAggregate({ appearAt: 99999, shardDoneAt: 99999 }), { timeoutMs: 900_000 });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'timeout');
  assert.equal(s.elapsed(), 900_000);
  assert.equal(r.output.heldBy.name, 'Typecheck + Vitest (shard 1/2)');
});

test('a draft-era failure also keeps waiting while a ready-era run is in progress', async () => {
  const s = sim({
    classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline,
    checkRuns: (t) => [cr('Playwright', t < 500 ? null : 'success', { check_suite: { id: 7 } })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T12:00:05Z' }],
    statuses: (t) => [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 1, created_at: '2026-01-01T11:00:00Z' }), ...(t >= 405 ? [st('Cross-model review', 'success', 'github-actions[bot]', { id: 2, created_at: '2026-01-01T12:06:40Z' })] : [])],
  });
  const r = await s.run();
  assert.equal(r.output.verdict, 'passed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 405_000);
});

// ---- a MISSING identity is held open by a run that started BEFORE ready (PR #196, 2026-11-09 plan B) ---------------------------
// The draft-era push already ran the tests; `gh pr ready` came 4 min later; the needs:-gated aggregate `test (windows)` appeared 22
// min after that. Only a missing identity relaxes the ready-era rule (a stale-skip / stale-fail needs a ready-era holder).

const PRE = '2026-01-01T11:00:00Z'; // before READY (12:00:00Z)
const HOLDER_SOURCES = ['check run', 'workflow run'];
// An unfinished pre-ready run of the head, seen as a check run (suite 9, created before ready) or only as a workflow run.
const holderRuns = (source, active = true) => (source === 'check run'
  ? { checkRuns: [cr('test (windows shard 1/3)', active ? null : 'success', { check_suite: { id: 9 } })], headRuns: [] }
  : { checkRuns: [], headRuns: active ? [{ id: 77, name: 'CI', status: 'in_progress', created_at: PRE, run_started_at: PRE, html_url: 'https://github.example/actions/77' }] : [] });
const preReadySuites = () => () => [{ created_at: PRE, run_started_at: PRE }];

for (const source of HOLDER_SOURCES) {
  test(`#196 shape (${source}): a pre-ready run in progress holds a missing aggregate past --appear-timeout, then the aggregate passes`, async () => {
    const aggregate = cr('test (windows)', 'success', { check_suite: { id: 9 } });
    const s = sim({
      classic: present('lint', 'test (windows)'), timeline: readyTimeline, suiteRuns: preReadySuites,
      statuses: (t) => [st('lint', t < 900 ? 'pending' : 'success')],
      checkRuns: (t) => [...holderRuns(source, t < 900).checkRuns, ...(t >= 900 ? [aggregate] : [])],
      headRuns: (t) => holderRuns(source, t < 900).headRuns,
    });
    const r = await s.run();
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    assert.equal(r.output.verdict, 'passed');
    assert.equal(s.elapsed(), 900_000, 'not at the 300s appear deadline');
    assert.equal(r.output.heldBy.kind, source === 'check run' ? 'check-run' : 'workflow-run');
    assert.equal(r.output.heldBy.predatesReady, true);
    assert.ok(s.progress.some((l) => /still running/.test(l) && /started before ready/.test(l)), s.progress.join(' | '));
  });

  test(`(${source}) a missing identity with a pre-ready run that never ends: verdict timeout at --timeout`, async () => {
    const s = sim({ classic: present('ci'), timeline: readyTimeline, suiteRuns: preReadySuites, ...holderRuns(source) }, { timeoutMs: 900_000 });
    const r = await s.run();
    assert.equal(r.output.verdict, 'timeout');
    assert.equal(s.elapsed(), 900_000);
    assert.equal(r.output.heldBy.predatesReady, true);
  });

  test(`(${source}) missing + only a COMPLETED pre-ready run: missing at the appear deadline, nothing holds`, async () => {
    const s = sim({ classic: present('ci'), timeline: readyTimeline, suiteRuns: preReadySuites, ...holderRuns(source, false) });
    const r = await s.run();
    assert.equal(r.output.verdict, 'missing');
    assert.equal(s.elapsed(), 300_000);
    assert.equal(r.output.heldBy, undefined);
  });

  test(`(${source}) only a stale-skip / stale-fail absent: a pre-ready run in progress does NOT hold (ready-era rule unchanged)`, async () => {
    const skip = sim({ classic: present('ci'), timeline: readyTimeline, suiteRuns: preReadySuites, ...holderRuns(source), checkRuns: [cr('ci', 'skipped', { check_suite: { id: 3 } }), ...holderRuns(source).checkRuns] });
    const a = await skip.run();
    assert.equal(a.output.verdict, 'stale-skipped');
    assert.equal(skip.elapsed(), 300_000);
    assert.equal(a.output.heldBy, undefined);
    const fail = sim({ classic: present('ci'), timeline: readyTimeline, suiteRuns: preReadySuites, ...holderRuns(source), checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } }), ...holderRuns(source).checkRuns] });
    const b = await fail.run();
    assert.equal(b.output.verdict, 'failed');
    assert.match(b.output.message, /ci=fail .*\(result predates ready\)/);
    assert.equal(fail.elapsed(), 300_000);
    assert.equal(b.output.heldBy, undefined);
  });

  for (const stale of ['skipped', 'failure']) {
    test(`(${source}) transition: a missing identity becomes a draft-era ${stale} while the pre-ready run still runs => the relaxed hold ends`, async () => {
      // `lint` is a draft-era skip throughout (mixed with the missing `ci`: the hold lasts while `ci` is missing); at 600s `ci` appears as a draft-era result
      const s = sim({
        classic: present('lint', 'ci'), timeline: readyTimeline, suiteRuns: preReadySuites, headRuns: holderRuns(source).headRuns,
        checkRuns: (t) => [cr('lint', 'skipped', { check_suite: { id: 3 } }), ...holderRuns(source).checkRuns, ...(t >= 600 ? [cr('ci', stale, { check_suite: { id: 4 } })] : [])],
      });
      const r = await s.run();
      assert.equal(s.elapsed(), 600_000, 'held past the 300s appear deadline while `ci` was missing, released when it stopped being missing');
      if (stale === 'skipped') {
        assert.equal(r.output.verdict, 'stale-skipped');
      } else {
        assert.equal(r.output.verdict, 'failed');
        assert.match(r.output.message, /ci=fail .*\(result predates ready\)/);
      }
      assert.equal(r.output.heldBy.predatesReady, true, 'the output still names the run that held the wait until then');
    });
  }
}

test('app scoping: a missing identity pinned to a non-Actions app is not held by an Actions run; one pinned to Actions, or unpinned, is', async () => {
  const VERCEL = 8329;
  const actionsRun = holderRuns('check run');
  const wfRun = holderRuns('workflow run');
  const pinned = sim({ classic: present(pin('deploy', VERCEL)), timeline: readyTimeline, suiteRuns: preReadySuites, ...actionsRun });
  const a = await pinned.run();
  assert.equal(a.output.verdict, 'missing', 'an Actions check run cannot produce a Vercel check');
  assert.equal(pinned.elapsed(), 300_000);
  const pinnedWf = sim({ classic: present(pin('deploy', VERCEL)), timeline: readyTimeline, suiteRuns: preReadySuites, ...wfRun });
  assert.equal((await pinnedWf.run()).output.verdict, 'missing', 'a workflow run is GitHub Actions');
  for (const [label, row] of [['pinned to Actions', pin('ci', ACTIONS)], ['unpinned', 'ci']]) {
    for (const holder of [actionsRun, wfRun]) {
      const s = sim({ classic: present(row), timeline: readyTimeline, suiteRuns: preReadySuites, ...holder }, { timeoutMs: 900_000 });
      const r = await s.run();
      assert.equal(r.output.verdict, 'timeout', `${label}: ${JSON.stringify(r.output)}`);
      assert.equal(r.output.heldBy.predatesReady, true);
    }
  }
  const vercelRun = { checkRuns: [cr('Vercel build', null, { app: { id: VERCEL }, check_suite: { id: 9 } })], headRuns: [] };
  const own = sim({ classic: present(pin('deploy', VERCEL)), timeline: readyTimeline, suiteRuns: preReadySuites, ...vercelRun }, { timeoutMs: 900_000 });
  const b = await own.run();
  assert.equal(b.output.verdict, 'timeout', 'a pre-ready run of the pinned app holds');
  assert.equal(b.output.heldBy.predatesReady, true);
});

test('a run whose age cannot be read holds a MISSING identity (predatesReady null) but not a stale-skip', async () => {
  const noAge = {
    checkRuns: [cr('shard', null)], // no check_suite workflow run to date it by, no started_at
    headRuns: [{ id: 80, name: 'CI', status: 'queued' }], // no created_at / run_started_at
  };
  const held = sim({ classic: present('ci'), timeline: readyTimeline, ...noAge, checkRuns: [{ ...noAge.checkRuns[0], check_suite: undefined }] }, { timeoutMs: 900_000 });
  const a = await held.run();
  assert.equal(a.output.verdict, 'timeout', JSON.stringify(a.output));
  assert.equal(a.output.heldBy.kind, 'check-run');
  assert.equal(a.output.heldBy.predatesReady, null);
  assert.equal(a.output.heldBy.createdAt, null);
  const wfOnly = sim({ classic: present('ci'), timeline: readyTimeline, headRuns: noAge.headRuns }, { timeoutMs: 900_000 });
  const b = await wfOnly.run();
  assert.equal(b.output.verdict, 'timeout');
  assert.equal(b.output.heldBy.kind, 'workflow-run');
  assert.equal(b.output.heldBy.predatesReady, null);
  // the strict (stale-skip) path keeps refusing such a run
  const strict = sim({ classic: present('ci'), timeline: readyTimeline, suiteRuns: preReadySuites, headRuns: noAge.headRuns, checkRuns: [cr('ci', 'skipped', { check_suite: { id: 3 } })] });
  const c = await strict.run();
  assert.equal(c.output.verdict, 'stale-skipped');
  assert.equal(strict.elapsed(), 300_000);
});

test('the pre-ready holder completes and the aggregate appears only on the confirming re-read: passed, re-read exactly once', async () => {
  const aggregate = cr('test (windows)', 'success', { check_suite: { id: 9 } });
  // polls 1-21 (t = 0..300s) read the check runs once each; read 22 is the confirming re-read. The holder is in progress up to read 20
  // (t = 285s, before the deadline) and completed from read 21, so the deadline poll sees no holder and no aggregate => re-read once.
  const s = sim({
    classic: present('test (windows)'), timeline: readyTimeline, suiteRuns: preReadySuites,
    checkRuns: (t, n) => (n >= 22 ? [aggregate] : [cr('test (windows shard 1/3)', n >= 21 ? 'success' : null, { check_suite: { id: 9 } })]),
  });
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 300_000);
  assert.equal(s.reads.checkRuns, 22, '21 polls + exactly one confirming re-read');
});

// ---- the absence verdict is confirmed by a fresh read of the check runs and statuses (#168 R1-B1) ----------------------

test('an aggregate that appears between the poll snapshot and the head-runs read is not reported missing: the check results are re-read first', async () => {
  const aggregate = cr('Typecheck + Vitest', 'success', { check_suite: { id: 7 } });
  // polls 1-21 (t = 0..300s) read the check runs once each; read 22 is the confirming re-read after the head's workflow runs showed nothing running
  const s = sim({ classic: present('Typecheck + Vitest'), timeline: readyTimeline, checkRuns: (t, n) => (n >= 22 ? [aggregate] : []) });
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 300_000, 'decided at the appear deadline, no extra wait');
  assert.equal(s.reads.checkRuns, 22);
});

test('the confirming re-read happens once: still nothing there => the old verdict, with a bounded number of reads', async () => {
  const s = sim({ classic: present('ci'), timeline: readyTimeline });
  const r = await s.run();
  assert.equal(r.output.verdict, 'missing');
  assert.equal(s.elapsed(), 300_000);
  assert.equal(s.reads.checkRuns, 22, '21 polls + exactly one confirming re-read');
  assert.equal(s.reads.headRuns.length, 2, 'the head runs are read by the poll and by the one confirmed pass');
  const skip = sim(lateAggregate({ appearAt: 99999, shardDoneAt: 0 }));
  const b = await skip.run();
  assert.equal(b.output.verdict, 'stale-skipped');
  assert.equal(skip.reads.checkRuns, 22);
});

// ---- a re-run keeps its run id and created_at: it is dated by run_started_at too (#168 R1-F2) ------------------------------

test('a re-run of a draft-era workflow run (old created_at, ready-era run_started_at) in progress holds the wait; one started before ready holds a MISSING identity too', async () => {
  const rerun = (startedAt) => ({ id: 31, name: 'CI', status: 'in_progress', created_at: '2026-01-01T11:00:00Z', run_started_at: startedAt, run_attempt: 2, html_url: 'https://github.example/actions/31' });
  const held = sim({ classic: present('ci'), timeline: readyTimeline, headRuns: [rerun('2026-01-01T12:05:00Z')] }, { timeoutMs: 900_000 });
  const a = await held.run();
  assert.equal(a.output.verdict, 'timeout', JSON.stringify(a.output));
  assert.equal(held.elapsed(), 900_000);
  assert.deepEqual(a.output.heldBy, { kind: 'workflow-run', id: 31, name: 'CI', status: 'in_progress', createdAt: '2026-01-01T12:05:00Z', url: 'https://github.example/actions/31', predatesReady: false });
  // spec change (2026-11-09 plan B), not a loosening: a MISSING identity is now held by a pre-ready run that could produce it
  const old = sim({ classic: present('ci'), timeline: readyTimeline, headRuns: [rerun('2026-01-01T11:30:00Z')] }, { timeoutMs: 900_000 });
  const b = await old.run();
  assert.equal(b.output.verdict, 'timeout');
  assert.equal(old.elapsed(), 900_000);
  assert.equal(b.output.heldBy.predatesReady, true);
});

test('a check run of a re-run workflow run (old created_at, ready-era run_started_at) in progress holds the wait; one started before ready holds a MISSING identity too', async () => {
  const world = (startedAt) => ({
    classic: present('Typecheck + Vitest'), timeline: readyTimeline,
    checkRuns: [cr('Typecheck + Vitest (shard 1/2)', null, { check_suite: { id: 7 } })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: startedAt, run_attempt: 2 }],
  });
  const held = sim(world('2026-01-01T12:05:00Z'), { timeoutMs: 900_000 });
  const a = await held.run();
  assert.equal(a.output.verdict, 'timeout');
  assert.equal(a.output.heldBy.kind, 'check-run');
  assert.equal(a.output.heldBy.name, 'Typecheck + Vitest (shard 1/2)');
  assert.equal(a.output.heldBy.predatesReady, false);
  // spec change (2026-11-09 plan B), not a loosening: a MISSING identity is now held by a pre-ready run that could produce it
  const old = sim(world('2026-01-01T11:30:00Z'), { timeoutMs: 900_000 });
  const b = await old.run();
  assert.equal(b.output.verdict, 'timeout');
  assert.equal(old.elapsed(), 900_000);
  assert.equal(b.output.heldBy.predatesReady, true);
});

// ---- a failure read from a commit status is confirmed by a fresh read before it is reported (#159 part 2) -----------

test('a Cross-model review failure superseded by a success after the poll read is not reported: statuses are re-read before the verdict', async () => {
  // read 1 (the poll) sees only the failure; the success is posted before the confirming read 2
  const s = sim({
    classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline,
    statuses: (t, n) => [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 10, created_at: '2026-01-01T12:00:05Z' }), ...(n >= 2 ? [st('Cross-model review', 'success', 'github-actions[bot]', { id: 11, created_at: '2026-01-01T12:00:09Z' })] : [])],
  });
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 0, 'decided in the same poll, no extra wait');
});

test('a status failure the re-read confirms is reported with the status id and created_at it rests on', async () => {
  const s = sim({ classic: present('lint'), timeline: readyTimeline, statuses: [st('lint', 'failure', 'x', { id: 42, created_at: '2026-01-01T12:00:05Z' })] });
  const r = await s.run();
  assert.equal(r.output.verdict, 'failed');
  assert.equal(s.reads.statuses, 2, 'one poll read + one confirming read');
  assert.deepEqual(r.output.statusEvidence, [{ context: 'lint', id: 42, state: 'failure', createdAt: '2026-01-01T12:00:05Z' }]);
  // a check-run failure needs no status re-read
  const run = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'failure')] });
  const b = await run.run();
  assert.equal(b.output.verdict, 'failed');
  assert.equal(run.reads.statuses, 1);
  assert.equal(b.output.statusEvidence, undefined);
});

test('a stale (draft-era) status failure at the appear deadline is confirmed by a re-read too, and a newer success wins', async () => {
  const s = sim({
    classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline,
    // the success is posted just before the confirming read at the appear deadline (poll 21, t = 300s; read 22 is its re-read)
    statuses: (t, n) => [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 1, created_at: '2026-01-01T11:00:00Z' }), ...(n >= 22 ? [st('Cross-model review', 'success', 'github-actions[bot]', { id: 2, created_at: '2026-01-01T12:04:59Z' })] : [])],
  });
  const r = await s.run();
  assert.equal(r.output.verdict, 'passed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 300_000);
});

// ---- draft-era failures are waited on like draft-era skips ---------------------------------------

const READY = '2026-01-01T12:00:00Z';
const readyTimeline = [{ event: 'ready_for_review', created_at: READY }];

test('a draft-era failure never re-posted stands as `failed` at the appear deadline, marked "result predates ready"', async () => {
  // status variant: created before the ready event
  const status = sim({ classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline, statuses: [st('Cross-model review', 'failure', 'github-actions[bot]', { created_at: '2026-01-01T11:00:00Z' })] });
  const a = await status.run();
  assert.equal(a.exitCode, 1);
  assert.equal(a.output.verdict, 'failed');
  assert.equal(status.elapsed(), 300_000);
  assert.match(a.output.message, /Cross-model review=fail .*\(result predates ready\)/);
  assert.equal(a.output.checks[0].state, 'stale-fail');
  assert.deepEqual(a.output.failures.map((f) => f.name), ['Cross-model review']);
  // check-run variant: its workflow run was created before the ready event
  const run = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } })], suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z' }] });
  const b = await run.run();
  assert.equal(b.output.verdict, 'failed');
  assert.equal(run.elapsed(), 300_000);
  assert.match(b.output.message, /predates ready/);
  // a non-Actions check run (no workflow run) is judged by its own timestamps
  const bare = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'cancelled', { completed_at: '2026-01-01T11:30:00Z' })] });
  const c = await bare.run();
  assert.equal(c.output.verdict, 'failed');
  assert.equal(bare.elapsed(), 300_000);
});

test('a draft-era failure that is re-posted after ready ends the wait on the new result (status and check run)', async () => {
  const status = sim({
    classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline,
    statuses: (t) => [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 1, created_at: '2026-01-01T11:00:00Z' }), ...(t >= 30 ? [st('Cross-model review', 'success', 'github-actions[bot]', { id: 2, created_at: '2026-01-01T12:00:30Z' })] : [])],
  });
  assert.equal((await status.run()).exitCode, 0);
  assert.equal(status.elapsed(), 30_000);
  const run = sim({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: (t) => [cr('ci', 'failure', { id: 1, check_suite: { id: 4 } }), ...(t >= 30 ? [cr('ci', 'success', { id: 2, check_suite: { id: 5 } })] : [])],
    suiteRuns: () => (id) => [{ created_at: id === 4 ? '2026-01-01T11:00:00Z' : '2026-01-01T12:00:10Z' }],
  });
  assert.equal((await run.run()).exitCode, 0);
  assert.equal(run.elapsed(), 30_000);
  // a fresh failure re-posted over the stale one is then reported at once
  const again = sim({
    classic: present(pin('Cross-model review', ACTIONS)), timeline: readyTimeline,
    statuses: (t) => [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 1, created_at: '2026-01-01T11:00:00Z' }), ...(t >= 30 ? [st('Cross-model review', 'failure', 'github-actions[bot]', { id: 2, created_at: '2026-01-01T12:00:30Z' })] : [])],
  });
  const r = await again.run();
  assert.equal(r.output.verdict, 'failed');
  assert.equal(again.elapsed(), 30_000);
  assert.doesNotMatch(r.output.message, /predates ready/);
});

test('a re-run (old created_at) whose run_started_at is after ready: its failure is fresh at once; one started before ready stays stale-fail (#173)', async () => {
  const world = (startedAt) => ({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: startedAt, run_attempt: 2 }],
  });
  const fresh = sim(world('2026-01-01T12:05:00Z'));
  const a = await fresh.run();
  assert.equal(a.output.verdict, 'failed', JSON.stringify(a.output));
  assert.equal(fresh.elapsed(), 0, 'reported at once, not at --appear-timeout');
  assert.equal(a.output.checks[0].state, 'fail');
  assert.doesNotMatch(a.output.message, /predates ready/);
  const cancelled = sim({ ...world('2026-01-01T12:05:00Z'), checkRuns: [cr('ci', 'cancelled', { check_suite: { id: 4 } })] });
  assert.equal((await cancelled.run()).output.checks[0].state, 'cancelled');
  assert.equal(cancelled.elapsed(), 0);
  const old = sim(world('2026-01-01T11:30:00Z'));
  const b = await old.run();
  assert.equal(b.output.verdict, 'failed');
  assert.equal(old.elapsed(), 300_000, 'a re-run started before ready is still a draft-era result');
  assert.equal(b.output.checks[0].state, 'stale-fail');
  assert.match(b.output.message, /predates ready/);
  // a run that was never re-run (no run_started_at) is dated by created_at as before
  const plain = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } })], suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z' }] });
  assert.equal((await plain.run()).output.checks[0].state, 'stale-fail');
});

test('a re-run seen on a LATER poll refreshes the cached suite start: its failure is fresh at once, not stale-fail from the draft-era cache (#173, #168 R3)', async () => {
  const s = sim({
    classic: present('ci'), timeline: readyTimeline,
    // poll 1 (t=0): the draft-era run failed; the re-run (same suite, new check run id) starts after ready and fails by poll 2 (t=15s)
    checkRuns: (t) => [t < 15 ? cr('ci', 'failure', { id: 1, check_suite: { id: 4 } }) : cr('ci', 'failure', { id: 2, check_suite: { id: 4 } })],
    suiteRuns: (t) => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: t < 15 ? '2026-01-01T11:00:00Z' : '2026-01-01T12:05:00Z', run_attempt: t < 15 ? 1 : 2 }],
  });
  const r = await s.run();
  assert.equal(r.output.verdict, 'failed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 15_000, 'reported at poll 2, not held to --appear-timeout by the cached draft-era start');
  assert.equal(r.output.checks[0].state, 'fail');
  assert.deepEqual(s.suiteCalls, [4, 4], 'one refresh when a newer check run of the suite appeared, not one per poll');
});

test('an OLD attempt\'s failure is not dated by a re-run that started after the check runs were read: the wait goes on and the re-run decides (#174, #168 R3-B1)', async () => {
  // t=0: the check-runs read returns the draft-era failure (own times 11:00); the workflow-run read, taken afterwards, already shows
  // attempt 2 started after ready. The failure belongs to attempt 1, so it is not a fresh failure of the ready-era code.
  const old = { id: 1, name: 'ci', check_suite: { id: 4 }, started_at: '2026-01-01T11:00:10Z', completed_at: '2026-01-01T11:00:30Z' };
  const rerun = (conclusion, t) => cr('ci', t >= 30 ? conclusion : null, { id: 2, check_suite: { id: 4 }, started_at: '2026-01-01T12:05:10Z', ...(t >= 30 ? { completed_at: '2026-01-01T12:06:00Z' } : {}) });
  const world = (conclusion) => ({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: (t) => [t < 15 ? cr('ci', 'failure', old) : rerun(conclusion, t)],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
  });
  const failing = sim(world('failure'));
  const a = await failing.run();
  assert.equal(a.output.verdict, 'failed', JSON.stringify(a.output));
  assert.equal(failing.elapsed(), 30_000, 'the old failure did not end the wait at t=0; the re-run\'s own failure did');
  assert.equal(a.output.checks[0].state, 'fail');
  const passing = sim(world('success'));
  const b = await passing.run();
  assert.equal(b.exitCode, 0, JSON.stringify(b.output));
  assert.equal(passing.elapsed(), 30_000);
});

test('a failure whose own times are after its attempt\'s start (the re-run\'s own) is still fresh at once (#174)', async () => {
  const own = sim({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 }, started_at: '2026-01-01T12:05:10Z', completed_at: '2026-01-01T12:06:00Z' })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
  });
  assert.equal((await own.run()).output.verdict, 'failed');
  assert.equal(own.elapsed(), 0);
});

// ---- a ready-era failure of a SUPERSEDED attempt waits for the newer attempt (#195) ---------------------------------------------

// Attempt 1 failed after the ready event (own times 12:01-12:02); the owner re-ran it, so the suite's workflow run is now attempt 2,
// started 12:05 after the check-runs read. The failure is not the final word on the head: the wait goes on until attempt 2 reports.
const oldAttempt = { id: 1, name: 'ci', check_suite: { id: 4 }, started_at: '2026-01-01T12:01:00Z', completed_at: '2026-01-01T12:02:00Z' };
const attempt2 = (status = 'in_progress', over = {}) => ({ id: 31, name: 'CI', status, created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2, html_url: 'https://github.example/actions/31', ...over });
const supersededWorld = (conclusion, { listedAt = 30, doneAt = 45 } = {}) => ({
  classic: present('ci'), timeline: readyTimeline,
  checkRuns: (t) => [t < listedAt ? cr('ci', 'failure', oldAttempt) : cr('ci', t < doneAt ? null : conclusion, { id: 2, check_suite: { id: 4 }, started_at: '2026-01-01T12:05:10Z', ...(t >= doneAt ? { completed_at: '2026-01-01T12:06:00Z' } : {}) })],
  suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
  headRuns: (t) => [attempt2(t < doneAt ? 'in_progress' : 'completed')],
});

test('a ready-era attempt-1 failure with attempt 2 already in flight keeps the wait open; attempt 2 passing ends it ok (#195)', async () => {
  const s = sim(supersededWorld('success'));
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.verdict, 'passed');
  assert.equal(s.elapsed(), 45_000, 'not at t=0 on the superseded failure; when attempt 2 completed');
  assert.ok(s.progress.some((l) => /ci=superseded/.test(l)), s.progress.join(' | '));
});

test('a superseded ready-era failure does not end the wait, and attempt 2 failing too is then reported as failed (#195)', async () => {
  const s = sim(supersededWorld('failure'));
  const r = await s.run();
  assert.equal(r.output.verdict, 'failed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 45_000, 'the wait outlived the superseded failure; attempt 2\'s own failure decided');
  assert.equal(r.output.checks[0].state, 'fail');
  assert.doesNotMatch(r.output.message, /superseded|predates ready/);
});

test('a newer attempt that is listed but never reports a check run: still-running holds to --timeout (verdict timeout, never ok) (#195)', async () => {
  const s = sim({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: [cr('ci', 'failure', oldAttempt)],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
    headRuns: [attempt2()],
  }, { timeoutMs: 900_000 });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'timeout', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 900_000);
  assert.equal(r.output.heldBy.id, 31);
});

test('a superseded failure whose newer attempt is not running and never reports ends at --appear-timeout as failed, never ok (#195)', async () => {
  const s = sim({
    classic: present('ci'), timeline: readyTimeline,
    checkRuns: [cr('ci', 'failure', oldAttempt)],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
    headRuns: [attempt2('completed')],
  });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'failed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 300_000);
  assert.match(r.output.message, /ci=fail .*superseded by a newer attempt that never reported/);
  assert.equal(r.output.checks[0].state, 'superseded');
});

test('a check run first seen pending and later completed refreshes the suite once: a re-run whose run read lagged is not judged by the stale start (#176, #168 R4-F1)', async () => {
  const s = sim({
    classic: present('ci', 'other'), timeline: readyTimeline,
    // t=0 the draft-era failure (attempt 1); t=15 the re-run's check run 2 is queued; t=30 the appear window is over and a
    // running workflow run holds the wait, so findHolder reads the suite while the run read still shows attempt 1; t=45 check
    // run 2 has failed and the run read now shows attempt 2 (started after ready).
    checkRuns: (t) => [t < 15 ? cr('ci', 'failure', { id: 1, check_suite: { id: 4 } }) : cr('ci', t < 45 ? null : 'failure', { id: 2, check_suite: { id: 4 } })],
    suiteRuns: (t) => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: t < 40 ? '2026-01-01T11:00:00Z' : '2026-01-01T12:05:00Z', run_attempt: t < 40 ? 1 : 2 }],
    headRuns: [{ id: 9, name: 'CI', status: 'in_progress', created_at: '2026-01-01T12:00:10Z' }],
  }, { appearTimeoutMs: 20_000 });
  const r = await s.run();
  assert.equal(r.output.verdict, 'failed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 45_000, 'reported when check run 2 failed, not held on the stale cached start');
  assert.equal(r.output.checks[0].state, 'fail');
  assert.deepEqual(s.suiteCalls, [4, 4, 4], 'one refresh for the newer id, one when it completed; never one per poll');
});

test('a re-run (old created_at, ready-era run_started_at) that SKIPPED is still stale-skipped: it replays the draft payload (#173)', async () => {
  const s = sim({
    classic: present('lint'), timeline: readyTimeline,
    checkRuns: [cr('lint', 'skipped', { check_suite: { id: 9 } })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T11:00:00Z', run_started_at: '2026-01-01T12:05:00Z', run_attempt: 2 }],
  });
  const r = await s.run();
  assert.equal(r.output.verdict, 'stale-skipped');
  assert.equal(s.elapsed(), 300_000);
});

test('a FRESH failure (after the ready event) still ends the wait at once; unreadable freshness counts as fresh', async () => {
  const status = sim({ classic: present('lint'), timeline: readyTimeline, statuses: [st('lint', 'failure', 'x', { created_at: '2026-01-01T12:00:05Z' })] });
  assert.equal((await status.run()).output.verdict, 'failed');
  assert.equal(status.elapsed(), 0);
  const run = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } })], suiteRuns: () => () => [{ created_at: '2026-01-01T12:00:05Z' }] });
  assert.equal((await run.run()).output.verdict, 'failed');
  assert.equal(run.elapsed(), 0);
  const unreadable = sim({ classic: present('ci'), timeline: readyTimeline, checkRuns: [cr('ci', 'failure', { check_suite: { id: 4 } })], suiteRuns: () => () => { throw new Error('HTTP 502'); } });
  assert.equal((await unreadable.run()).output.verdict, 'failed');
  assert.equal(unreadable.elapsed(), 0, 'could not tell: fail fast');
  const noTimeline = sim({ classic: present('lint'), timeline: () => { throw new Error('HTTP 502'); }, statuses: [st('lint', 'failure', 'x', { created_at: '2000-01-01T00:00:00Z' })] });
  const n = await noTimeline.run();
  assert.equal(n.output.verdict, 'failed');
  assert.equal(noTimeline.elapsed(), 0);
});

test('--wait-all keeps waiting on a stale failure; a stale failure beside a missing check reports the missing one first', async () => {
  const world = { classic: present('Test integrity', 'other'), timeline: readyTimeline, statuses: [st('Test integrity', 'failure', 'x', { created_at: '2026-01-01T11:00:00Z' })], checkRuns: [cr('other', 'success')] };
  const s = sim(world, { waitAll: true });
  const r = await s.run();
  assert.equal(r.output.verdict, 'failed');
  assert.equal(s.elapsed(), 300_000);
  const m = await sim({ ...world, checkRuns: [] }).run();
  assert.equal(m.output.verdict, 'missing');
  assert.match(m.output.message, /a draft-era failure stands for: Test integrity/);
});

test('a skipped check whose workflow run only started before the ready event stays stale-skipped at the appear deadline', async () => {
  const world = {
    pr: { ...PR, createdAt: '2026-11-04T08:32:39Z' },
    classic: present(pin('Typecheck + Vitest', ACTIONS)),
    timeline: fx('timeline-race.json'),
    checkRuns: fx('check-runs-race.json').filter((r) => r.id === 126476672841),
    suiteRuns: () => (id) => fx('workflow-runs-by-suite.json')[id] ?? [],
  };
  const s = sim(world);
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'stale-skipped');
  assert.equal(s.elapsed(), 300_000);
  assert.match(r.output.message, /Typecheck \+ Vitest/);
  assert.match(r.output.message, /did not run on the ready event: re-run it or ask the owner/);
});

test('an unreadable workflow-run lookup, and a skipped run with no workflow run, read as stale (never as done)', async () => {
  const skipped = cr('lint', 'skipped', { check_suite: { id: 9 } });
  const broken = sim({ classic: present('lint'), checkRuns: [skipped], suiteRuns: () => () => { throw new Error('HTTP 502'); } }, { appearTimeoutMs: 30_000 });
  assert.equal((await broken.run()).output.verdict, 'stale-skipped');
  const nonActions = sim({ classic: present('lint'), checkRuns: [cr('lint', 'skipped', { check_suite: { id: 9 } })], suiteRuns: () => () => [] }, { appearTimeoutMs: 30_000 });
  assert.equal((await nonActions.run()).output.verdict, 'stale-skipped');
  const noSuite = sim({ classic: present('lint'), checkRuns: [{ ...cr('lint', 'skipped'), check_suite: undefined }] }, { appearTimeoutMs: 30_000 });
  assert.equal((await noSuite.run()).output.verdict, 'stale-skipped');
});

test('a fresh skip (workflow run created at or after the ready event) is done, and the wait still covers a pending check', async () => {
  const world = {
    pr: { ...PR, createdAt: '2026-01-01T00:00:00Z' },
    classic: present('A', 'B', 'C'),
    checkRuns: (t) => [cr('A', 'skipped', { id: 1, check_suite: { id: 5 } }), cr('B', t < 30 ? null : 'success', { id: 2 }), cr('C', 'success', { id: 3 })],
    suiteRuns: () => () => [{ created_at: '2026-01-01T00:10:00Z' }],
  };
  const s = sim(world);
  const r = await s.run();
  assert.equal(r.exitCode, 0);
  assert.equal(s.elapsed(), 30_000);
  assert.equal(r.output.checks.find((c) => c.name === 'A').state, 'fresh-skip');
});

test('readyAt is the latest ready_for_review event; a PR that was never a draft uses its creation time', async () => {
  const events = [{ event: 'ready_for_review', created_at: '2026-01-01T01:00:00Z' }, { event: 'labeled', created_at: '2026-01-01T09:00:00Z' }, { event: 'ready_for_review', created_at: '2026-01-01T03:00:00Z' }];
  const world = { classic: present('A'), checkRuns: [cr('A', 'skipped', { check_suite: { id: 5 } })], timeline: events, suiteRuns: () => () => [{ created_at: '2026-01-01T02:00:00Z' }] };
  const stale = sim(world, { appearTimeoutMs: 15_000 });
  const a = await stale.run();
  assert.equal(a.output.verdict, 'stale-skipped', 'the run (02:00) is older than the LATEST ready event (03:00)');
  assert.equal(a.output.readyAt, '2026-01-01T03:00:00Z');
  const never = sim({ ...world, timeline: [] });
  const b = await never.run();
  assert.equal(b.output.verdict, 'passed');
  assert.equal(b.output.readyAt, PR.createdAt);
});

// ---- appearing, disappearing, re-runs ----------------------------------------------------------

test('partial appearance: A passed, B never reported => waits the appear window, then `missing` naming B', async () => {
  const s = sim({ classic: present('A', 'B'), checkRuns: [cr('A', 'success')] });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'missing');
  assert.equal(s.elapsed(), 300_000);
  assert.match(r.output.message, /B/);
  assert.equal(r.output.checks.find((c) => c.name === 'B').state, 'missing');
});

test('a row that disappears is not a pass: the wait goes on until it is back', async () => {
  const world = {
    classic: present('A', 'B'),
    checkRuns: (t) => [cr('A', t < 15 ? null : 'success', { id: 1 }), ...(t === 15 ? [] : [cr('B', 'success', { id: 2 })])],
  };
  const s = sim(world);
  const r = await s.run();
  assert.equal(r.exitCode, 0);
  assert.equal(s.elapsed(), 30_000, 'at 15s A passed but B was gone: no exit');
});

test('a queued re-run with null timestamps beats an older success (highest id, never startedAt)', async () => {
  const older = cr('ci', 'success', { id: 100, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:05:00Z' });
  const requeued = (conclusion) => ({ id: 200, name: 'ci', status: conclusion ? 'completed' : 'queued', conclusion, started_at: null, completed_at: null, app: { id: ACTIONS }, check_suite: { id: 1 } });
  const s = sim({ classic: present(pin('ci', ACTIONS)), checkRuns: (t) => [older, requeued(t < 30 ? null : 'success')] });
  const r = await s.run();
  assert.equal(r.exitCode, 0);
  assert.equal(s.elapsed(), 30_000, 'the old success did not release the wait while the re-run was queued');
  const failing = sim({ classic: present(pin('ci', ACTIONS)), checkRuns: [older, requeued('failure')] });
  assert.equal((await failing.run()).output.verdict, 'failed');
});

test('real same-suite re-runs (PR 1599, PR 1617): the later run has the larger id and decides', async () => {
  const classic = present(pin('Typecheck + Vitest', ACTIONS));
  const rerun = fx('check-runs-rerun.json').filter((r) => r.name === 'Typecheck + Vitest');
  assert.equal(rerun.length, 2);
  const [newer, older] = rerun;
  assert.ok(newer.id > older.id && Date.parse(newer.started_at) > Date.parse(older.started_at), 'fixture: a re-run is a NEW, larger id');
  assert.equal(older.conclusion, 'failure');
  assert.equal(newer.conclusion, 'success');
  assert.equal((await sim({ classic, checkRuns: rerun }).run()).output.verdict, 'passed');
  const pw = fx('check-runs-rerun-playwright.json');
  const succeededLater = pw.filter((r) => r.conclusion !== 'skipped');
  assert.ok(succeededLater.length >= 2);
  assert.equal((await sim({ classic: present(pin('Playwright suite', ACTIONS)), checkRuns: succeededLater }).run()).output.verdict, 'passed');
});

// ---- two producers, statuses, pins -------------------------------------------------------------

test('the same name from two apps: a pin picks its app; an unpinned identity takes the worst of both', async () => {
  const runs = [cr('build', 'success', { id: 10, app: { id: 1 } }), cr('build', 'failure', { id: 11, app: { id: 2 } })];
  assert.equal((await sim({ classic: present(pin('build', 1)), checkRuns: runs }).run()).output.verdict, 'passed');
  assert.equal((await sim({ classic: present(pin('build', 2)), checkRuns: runs }).run()).output.verdict, 'failed');
  const unpinned = await sim({ classic: present('build'), checkRuns: runs }).run();
  assert.equal(unpinned.output.verdict, 'failed');
  assert.deepEqual(unpinned.output.failures.map((f) => f.name), ['build']);
});

test('a legacy status context (no app): pending waits, success passes, failure and error fail at once', async () => {
  const s = sim({ classic: present('lint'), statuses: (t) => [st('lint', 'pending', 'someone', { id: 1 }), ...(t >= 30 ? [st('lint', 'success', 'someone', { id: 2 })] : [])] });
  assert.equal((await s.run()).exitCode, 0);
  assert.equal(s.elapsed(), 30_000);
  for (const state of ['failure', 'error']) {
    const f = sim({ classic: present('lint'), statuses: [st('lint', state, 'someone')] });
    const r = await f.run();
    assert.equal(r.output.verdict, 'failed');
    assert.equal(f.elapsed(), 0);
  }
});

test('a pinned identity with a success status from the wrong creator stays `missing` (never passed)', async () => {
  const wrong = sim({ classic: present(pin('Test integrity', ACTIONS)), statuses: [st('Test integrity', 'success', 'ianjamila')] });
  const r = await wrong.run();
  assert.equal(r.output.verdict, 'missing');
  assert.equal(wrong.elapsed(), 300_000);
  // an app with no known bot can never be satisfied by a status
  const unknown = sim({ classic: present(pin('Deploy', 777)), statuses: [st('Deploy', 'success', 'deploy-app[bot]')] }, { appearTimeoutMs: 30_000 });
  assert.equal((await unknown.run()).output.verdict, 'missing');
  // the same status from the app's known bot is accepted
  const right = sim({ classic: present(pin('Test integrity', ACTIONS), pin('Vercel', 8329)), statuses: [st('Test integrity', 'success', 'github-actions[bot]'), st('Vercel', 'success', 'vercel[bot]')] });
  assert.equal((await right.run()).output.verdict, 'passed');
});

test('a check run that passed and a status that failed under one unpinned name => failed', async () => {
  const r = await sim({ classic: present('ci'), checkRuns: [cr('ci', 'success')], statuses: [st('ci', 'failure', 'someone')] }).run();
  assert.equal(r.output.verdict, 'failed');
});

test('KNOWN_APP_BOTS: Actions and the Vercel login seen on real EW heads (PR 1627, PR 1631)', async () => {
  assert.equal(KNOWN_APP_BOTS[15368], 'github-actions[bot]');
  assert.equal(KNOWN_APP_BOTS[8329], 'vercel[bot]');
  for (const f of ['statuses-green.json', 'statuses-race.json']) {
    assert.ok(fx(f).some((s) => s.context === 'Vercel' && s.creator.login === 'vercel[bot]'), `${f}: a real Vercel status is created by vercel[bot]`);
  }
});

test('a whole real green head (PR 1627) under EW main\'s real protection: all six required identities pass in one poll', async () => {
  const classic = readClassicRequired({ protection: () => ({ status: 200, json: fx('protection-main.json') }) }, 'main');
  assert.equal(classic.kind, 'present');
  assert.equal(classic.rows.length, 6);
  const s = sim({ classic, rules: fx('rules-empty.json'), checkRuns: fx('check-runs-green.json'), statuses: fx('statuses-green.json') });
  const r = await s.run();
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(s.elapsed(), 0);
  assert.deepEqual(r.output.requiredSource, { classic: 'present', rules: 'absent' });
  assert.equal(r.output.checks.length, 6);
  assert.ok(r.output.checks.every((c) => c.state === 'pass'));
});

// ---- failures, --wait-all ----------------------------------------------------------------------

test('a failure ends the wait at once, naming the check and its url', async () => {
  const s = sim({ classic: present('A', 'B'), checkRuns: [cr('A', 'failure', { html_url: 'https://github.example/runs/9' }), cr('B', null)] });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'failed');
  assert.equal(s.elapsed(), 0, 'B is still pending but A already failed');
  assert.match(r.output.message, /A=fail \(https:\/\/github\.example\/runs\/9\)/);
  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    assert.equal((await sim({ classic: present('A'), checkRuns: [cr('A', conclusion)] }).run()).output.verdict, 'failed', conclusion);
  }
  assert.equal((await sim({ classic: present('A'), checkRuns: [cr('A', 'neutral')] }).run()).output.verdict, 'passed');
});

test('--wait-all: an expected red guard + a pending check + a pass => waits for the pending one, then lists the failure', async () => {
  const world = {
    classic: present(pin('Test integrity', ACTIONS), 'slow', 'quick'),
    statuses: [st('Test integrity', 'failure')],
    checkRuns: (t) => [cr('slow', t < 30 ? null : 'success', { id: 1 }), cr('quick', 'success', { id: 2 })],
  };
  const s = sim(world, { waitAll: true });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'failed');
  assert.equal(s.elapsed(), 30_000);
  assert.deepEqual(r.output.failures.map((f) => f.name), ['Test integrity']);
  assert.deepEqual(Object.fromEntries(r.output.checks.map((c) => [c.name, c.state])), { 'Test integrity': 'fail', slow: 'pass', quick: 'pass' });
  const eager = sim(world);
  await eager.run();
  assert.equal(eager.elapsed(), 0, 'without --wait-all the failure ends the wait at once');
});

test('--wait-all that never settles ends at a deadline with the deadline verdict, the failure still listed in checks', async () => {
  const s = sim({ classic: present('red', 'never'), checkRuns: [cr('red', 'failure')] }, { waitAll: true });
  const r = await s.run();
  assert.equal(r.output.verdict, 'missing');
  assert.equal(r.output.checks.find((c) => c.name === 'red').state, 'fail');
});

test('a check that stays pending past --timeout => `timeout`', async () => {
  const s = sim({ classic: present('A'), checkRuns: [cr('A', null)] }, { timeoutMs: 100_000 });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'timeout');
  assert.ok(s.elapsed() >= 100_000 && s.elapsed() < 120_000);
});

// ---- the PR itself -----------------------------------------------------------------------------

test('a draft at the start is exit 2; going back to draft, or a moved head, later is exit 1', async () => {
  const start = await sim({ pr: { ...PR, isDraft: true }, classic: present('A') }).run();
  assert.equal(start.exitCode, 2);
  assert.equal(start.output.verdict, 'draft');
  assert.match(start.output.message, /gh pr ready/);
  const later = await sim({ pr: (t) => ({ ...PR, isDraft: t >= 15 }), classic: present('A'), checkRuns: (t) => [cr('A', t < 30 ? null : 'success')] }).run();
  assert.equal(later.exitCode, 1);
  assert.equal(later.output.verdict, 'draft');
  const moved = await sim({ pr: (t) => ({ ...PR, head: t >= 15 ? 'b'.repeat(40) : HEAD }), classic: present('A'), checkRuns: [cr('A', null)] }).run();
  assert.equal(moved.output.verdict, 'head-moved');
  assert.equal(moved.output.newHead, 'b'.repeat(40));
});

test('the PR is re-read before a success: a head that moves right at the end is `head-moved`, not a pass', async () => {
  let reads = 0;
  const world = { classic: present('A'), checkRuns: [cr('A', 'success')], pr: () => ({ ...PR, head: (reads += 1) >= 2 ? 'c'.repeat(40) : HEAD }) };
  const r = await sim(world).run();
  assert.equal(r.output.verdict, 'head-moved');
  assert.equal(r.exitCode, 1);
});

// A retarget keeps the head but changes which branch's protection decides the required set: the cached one is no longer the right one.
test('the base branch changing mid-wait (same head) => `base-changed` (exit 1), not a verdict from the old required set', async () => {
  const s = sim({ pr: (t) => ({ ...PR, base: t >= 15 ? 'release' : 'main' }), classic: present('A'), checkRuns: [cr('A', null)] });
  const r = await s.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'base-changed');
  assert.equal(r.output.head, HEAD);
  assert.match(r.output.message, /main.*release/);
  assert.deepEqual(s.reads.classic, ['main'], 'no policy read for the new base: the wait restarts');
});

test('the base branch changing only at the final reread before a success => `base-changed`, not a pass', async () => {
  let reads = 0;
  const r = await sim({ classic: present('A'), checkRuns: [cr('A', 'success')], pr: () => ({ ...PR, base: (reads += 1) >= 2 ? 'release' : 'main' }) }).run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'base-changed');
});

test('an unchanged base keeps the cached required set: one classic and one rules read over the whole wait', async () => {
  const s = sim({ classic: present('A'), checkRuns: (t) => [cr('A', t < 45 ? null : 'success')] });
  const r = await s.run();
  assert.equal(r.output.verdict, 'passed');
  assert.deepEqual(s.reads.classic, ['main']);
  assert.deepEqual(s.reads.rules, ['main']);
});

// ---- the required set --------------------------------------------------------------------------

test('both policy sources absent => `no-required-checks` (exit 1)', async () => {
  const r = await sim({ classic: { kind: 'absent' }, rules: [] }).run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.verdict, 'no-required-checks');
});

test('classic unreadable + rules readable (and the reverse) => `unverified` even when everything reported passes', async () => {
  const ruleset = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: ACTIONS }] } }];
  const runs = [cr('ci', 'success')];
  const a = await sim({ classic: { kind: 'unreadable', reason: 'HTTP 403' }, rules: ruleset, checkRuns: runs, }, { configChecks: ['ci', 'Test integrity'] }).run();
  assert.equal(a.exitCode, 1);
  assert.equal(a.output.verdict, 'unverified');
  assert.match(a.output.message, /classic: HTTP 403/);
  assert.deepEqual(a.output.configChecks.map((c) => [c.name, c.state]), [['ci', 'pass'], ['Test integrity', 'missing']]);
  const b = await sim({ classic: present(pin('ci', ACTIONS)), rules: () => { throw new Error('HTTP 502'); }, checkRuns: runs }).run();
  assert.equal(b.output.verdict, 'unverified');
  assert.match(b.output.message, /rules: HTTP 502/);
  assert.deepEqual(b.output.requiredSource, { classic: 'present', rules: 'unreadable' });
  // a readable source that has a failing check is still reported as failed
  const c = await sim({ classic: { kind: 'unreadable', reason: 'x' }, rules: ruleset, checkRuns: [cr('ci', 'failure')] }).run();
  assert.equal(c.output.verdict, 'failed');
});

test('both sources unreadable => `unverified` straight away, listing the config checks and their states', async () => {
  const s = sim({ classic: { kind: 'unreadable', reason: 'HTTP 403' }, rules: () => { throw new Error('HTTP 403'); }, checkRuns: [cr('ci', 'success')] }, { configChecks: ['ci', 'Hard-stop scan'] });
  const r = await s.run();
  assert.equal(r.output.verdict, 'unverified');
  assert.equal(s.elapsed(), 0);
  assert.deepEqual(r.output.configChecks.map((c) => [c.name, c.state]), [['ci', 'pass'], ['Hard-stop scan', 'missing']]);
});

test('an unreadable source is asked again on the next poll and the union of both sources is required', async () => {
  let asked = 0;
  const ruleset = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'from-rules', integration_id: -1 }] } }];
  const world = {
    classic: () => ((asked += 1) === 1 ? { kind: 'unreadable', reason: 'HTTP 502' } : present('from-classic')),
    rules: ruleset,
    checkRuns: (t) => [cr('from-rules', t < 15 ? null : 'success', { id: 1 }), ...(t >= 30 ? [cr('from-classic', 'success', { id: 2 })] : [])],
  };
  const s = sim(world);
  const r = await s.run();
  assert.equal(r.output.verdict, 'passed', JSON.stringify(r.output));
  assert.equal(s.elapsed(), 30_000, 'once classic answered, its check was required too');
  assert.deepEqual(r.output.checks.map((c) => c.name).sort(), ['from-classic', 'from-rules']);
});

// ---- GitHub read failures ----------------------------------------------------------------------

test('5 reads in a row failing => exit 3 `github`; a success in between resets the count', async () => {
  const dead = sim({ pr: () => { throw new Error('HTTP 502'); }, classic: present('A') });
  const r = await dead.run();
  assert.equal(r.exitCode, 3);
  assert.equal(r.output.verdict, 'github');
  assert.equal(dead.elapsed(), 15_000 * (MAX_READ_FAILURES - 1));
  assert.match(r.output.message, /HTTP 502/);
  let polls = 0;
  const flaky = sim({
    classic: present('A'),
    checkRuns: () => {
      polls += 1;
      if (polls !== 5 && polls <= 8) throw new Error('HTTP 502'); // fails 4, ok once (pending), fails 3 more, then good
      return [cr('A', polls === 5 ? null : 'success')];
    },
  });
  const ok = await flaky.run();
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.output));
});

// ---- the shared protection readers -------------------------------------------------------------

test('readClassicRequired: present (checks + legacy contexts), absent (404 not protected, no required checks), unreadable (anything else)', () => {
  const present_ = readClassicRequired({ protection: () => ({ status: 200, json: fx('protection-main.json') }) }, 'main');
  assert.deepEqual(present_.rows.find((r) => r.context === 'Vercel'), { context: 'Vercel', appId: 8329 });
  assert.deepEqual(present_.rows.find((r) => r.context === 'Test integrity'), { context: 'Test integrity', appId: ACTIONS });
  const legacy = readClassicRequired({ protection: () => ({ status: 200, json: { required_status_checks: { contexts: ['old'], checks: [{ context: 'new', app_id: -1 }] } } }) }, 'main');
  assert.deepEqual(legacy.rows, [{ context: 'new', appId: null }, { context: 'old', appId: null }], '-1 means any app; a context only in the legacy list is any app');
  assert.deepEqual(readClassicRequired({ protection: () => ({ status: 404, reason: 'not-protected', message: 'Branch not protected' }) }, 'main'), { kind: 'absent' });
  assert.deepEqual(readClassicRequired({ protection: () => ({ status: 200, json: { enforce_admins: { enabled: true } } }) }, 'main'), { kind: 'absent' });
  assert.deepEqual(readClassicRequired({ protection: () => ({ status: 200, json: { required_status_checks: { checks: [], contexts: [] } } }) }, 'main'), { kind: 'absent' });
  for (const reply of [{ status: 403, reason: 'permission', message: 'forbidden' }, { status: 404, reason: 'not-found', message: 'Not Found' }]) {
    assert.equal(readClassicRequired({ protection: () => reply }, 'main').kind, 'unreadable', reply.reason);
  }
  const thrown = readClassicRequired({ protection: () => { throw new Error('HTTP 502'); } }, 'main');
  assert.equal(thrown.kind, 'unreadable');
  assert.match(thrown.reason, /HTTP 502/);
});

test('requiredFromRules: an empty list is absent (authoritative); a required_status_checks rule is present with integration ids; junk is unreadable', () => {
  assert.deepEqual(requiredFromRules(fx('rules-empty.json')), { kind: 'absent' });
  assert.deepEqual(requiredFromRules([{ type: 'deletion' }, { type: 'pull_request', parameters: {} }]), { kind: 'absent' });
  const sample = [
    { type: 'required_status_checks', ruleset_source_type: 'Repository', ruleset_id: 1, parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci', integration_id: 15368 }, { context: 'lint' }] } },
    { type: 'required_status_checks', ruleset_id: 2, parameters: { required_status_checks: [{ context: 'e2e', integration_id: 0 }] } },
  ];
  assert.deepEqual(requiredFromRules(sample), { kind: 'present', rows: [{ context: 'ci', appId: 15368 }, { context: 'lint', appId: null }, { context: 'e2e', appId: null }] });
  assert.equal(requiredFromRules({ message: 'x' }).kind, 'unreadable');
  assert.equal(requiredFromRules([{ type: 'required_status_checks', parameters: {} }]).kind, 'unreadable');
});
