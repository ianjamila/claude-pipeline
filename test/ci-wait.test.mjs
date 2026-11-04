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
const at = (v, t) => (typeof v === 'function' ? v(t) : v);

function sim(world, options = {}) {
  let t = 0;
  const calls = [];
  const readers = {
    pr: async () => at(world.pr ?? PR, t / 1000),
    classic: async () => at(world.classic, t / 1000),
    rules: async () => at(world.rules ?? [], t / 1000),
    checkRuns: async () => at(world.checkRuns ?? [], t / 1000),
    statuses: async () => at(world.statuses ?? [], t / 1000),
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
