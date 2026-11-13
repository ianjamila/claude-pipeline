// codex-review and the evidence it leaves for a substitute reviewer (plan 2026-11-11-codex-substitute-reviewer: the T1 quota proof wired in, R4-10 / R4-12 / R5-7
// route.json lifecycle, Rev 6 eligibility, the machine-wide Codex record). The real CLI against a throwaway repo, a fake gh and a scripted fake Codex.
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundWorld, findingsOf, low } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { addWaiting, readStatus, recordOutage } from '../pipeline/lib/codex-usage.mjs';
import { OUTAGE_NO_RESET_MS } from '../pipeline/lib/codex-usage.mjs';
import { quotaValidUntilMs, substituteEligibility } from '../pipeline/lib/route-record.mjs';

const QUOTA = "You've hit your usage limit. Upgrade to Pro, or try again in 5 minutes.";
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// A world plus a private Codex record folder (never the account's real one).
function world(t, opts = {}) {
  const w = roundWorld(t, { max: 3, ...opts });
  const status = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-route-status-'))), 'codex');
  t.after(() => rmSync(join(status, '..'), { recursive: true, force: true }));
  w.status = status;
  w.run = (round, env = {}, { from = w.base, to = w.head } = {}) => w.cli(
    ['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high'],
    { PIPELINE_CODEX_STATUS_DIR: status, ...env },
  );
  w.route = (round = 1) => JSON.parse(readFileSync(join(w.repo.dir, '.review', `round-${round}`, 'route.json'), 'utf8'));
  w.attempts = (round = 1) => readdirSync(join(w.repo.dir, '.review', `round-${round}`)).filter((n) => n.startsWith('attempt-'));
  w.record = () => readStatus({ dir: status });
  w.ok = () => ({ FAKE_CODEX_OUTPUT: w.file('ok.json', findingsOf([], [low()])) });
  // a thread id and CODEX_HOME of its own: the real session log of whoever runs the suite must not decide the proof or the reset time
  w.quota = (msg = QUOTA) => ({ FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: msg, FAKE_CODEX_THREAD_ID: randomUUID(), CODEX_HOME: join(w.scratch, 'codex-home') });
  return w;
}

test('a quota stop is exit 3 with substitute.eligible, and route.json holds the quota evidence of that attempt', (t) => {
  const w = world(t);
  const r = w.run(1, w.quota());
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.reason, 'quota');
  assert.equal(r.json.substitute.eligible, true);
  assert.equal(r.json.substitute.why, 'quota');
  assert.equal(r.json.substitute.agent, 'substitute-opus', 'a low-risk PR');
  assert.equal(r.json.quota.proof, 'stream');
  assert.ok(r.json.substitute.resetAt, 'in 5 minutes is a parsed reset time');
  assert.equal(r.json.substitute.waitUntil, undefined);

  const route = w.route();
  const dir = join(w.repo.dir, '.review', 'round-1');
  assert.deepEqual(w.attempts(), [`attempt-${route.attemptId}`]);
  assert.deepEqual([route.evidence, route.outcome, route.reason, route.round, route.base, route.head], ['quota', 'failed', 'quota', 1, w.base, w.head]);
  assert.equal(route.resetAt, r.json.substitute.resetAt);
  assert.match(route.resetText, /5 minutes/);
  assert.deepEqual(route.errorEvent, { type: 'turn.failed', message: QUOTA });
  assert.equal(route.proof, 'stream');
  assert.equal(route.risk, 'low');
  assert.equal(route.agent, 'substitute-opus');
  assert.equal(route.promptSha256, sha(readFileSync(join(dir, 'prompt.md'))), 'bound to the prompt Codex was sent');
  assert.equal(route.patchSha256, sha(readFileSync(join(dir, 'diff.patch'))), 'bound to the patch');
  assert.ok(route.at && route.startedAt);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'no round from a failed attempt');
  // the machine-wide record: the outage and the parked PR
  const rec = w.record();
  assert.equal(rec.lastOutage.round, 1);
  assert.equal(rec.waiting.length, 1);
  assert.equal(rec.waiting[0].pr, 7);
  assert.equal(rec.waiting[0].worktree, w.repo.dir);
});

test('a high-risk PR (ever) gets substitute-fable; review.substitute.mode off is eligible:false mode-off', (t) => {
  const high = world(t, { yml: 'risk:\n  high_risk_paths: ["src/big.js"]\n' });
  const a = high.run(1, high.quota());
  assertExit(a, 3, a.stdout);
  assert.deepEqual([a.json.substitute.eligible, a.json.substitute.agent], [true, 'substitute-fable']);
  assert.equal(high.route().risk, 'high');

  const off = world(t, { review: '  substitute:\n    mode: off\n' });
  const b = off.run(1, off.quota());
  assertExit(b, 3, b.stdout);
  assert.deepEqual([b.json.reason, b.json.substitute.eligible, b.json.substitute.why], ['quota', false, 'mode-off']);
  assert.equal(off.route().evidence, 'quota', 'the fact is recorded; prepare judges the mode');
});

test('never wait by default: a reset 5 minutes away is still eligible; min_wait_minutes 20 makes it eligible:false with waitUntil', (t) => {
  const never = world(t);
  const a = never.run(1, never.quota());
  assert.equal(a.json.substitute.eligible, true);
  const waits = world(t, { review: '  substitute:\n    min_wait_minutes: 20\n' });
  const b = waits.run(1, waits.quota());
  assertExit(b, 3, b.stdout);
  assert.deepEqual([b.json.substitute.eligible, b.json.substitute.why], [false, 'reset-near']);
  assert.equal(b.json.substitute.waitUntil, b.json.substitute.resetAt);
  const far = waits.run(1, waits.quota("You've hit your usage limit. Try again in 3 hours."));
  assert.equal(far.json.substitute.eligible, true, 'a reset beyond the wait is not waited for');
  const unknown = waits.run(1, waits.quota("You've hit your usage limit. Come back later."));
  assert.equal(unknown.json.substitute.eligible, true, 'no reset time: nothing to wait until');
  assert.equal(unknown.json.substitute.resetAt, null);
});

test('auth, unavailable, error and malformed are eligible:false and leave no outage record; route.json says none', (t) => {
  const w = world(t);
  for (const [env, reason] of [
    [{ FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'Not logged in. Run codex login.' }, 'auth'],
    [{ FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'segfault' }, 'error'],
    [{ FAKE_CODEX_NO_WRITE: '1' }, 'malformed'],
  ]) {
    const r = w.run(1, env);
    assertExit(r, 3, r.stdout);
    assert.equal(r.json.reason, reason);
    assert.equal(r.json.substitute.eligible, false);
    assert.equal(r.json.substitute.why, `not-quota:${reason}`);
    assert.equal(w.route().evidence, 'none');
    assert.equal(w.route().reason, reason);
  }
  assert.equal(w.record().lastOutage, null);
  assert.deepEqual(w.record().waiting, []);
});

test('quota then auth on a later attempt: the later attempt replaces the quota evidence', (t) => {
  const w = world(t);
  assertExit(w.run(1, w.quota()), 3);
  const first = w.route();
  assert.equal(first.evidence, 'quota');
  const r = w.run(1, { FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'Not logged in. Run codex login.' });
  assertExit(r, 3);
  const now = w.route();
  assert.notEqual(now.attemptId, first.attemptId);
  assert.deepEqual([now.evidence, now.reason], ['none', 'auth']);
  assert.equal(w.attempts().length, 2, 'each attempt keeps its own folder');
});

test('a Codex timeout is retried once: timeout then success is ok with retried; two timeouts is exit 3 timedOut and never a substitute', (t) => {
  const w = world(t);
  const hangOnce = join(w.scratch, 'hung-once');
  const ok = w.run(1, { PIPELINE_CODEX_TIMEOUT_MS: '600', FAKE_CODEX_HANG_ONCE: hangOnce, ...w.ok() });
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json.retried, { reason: 'timeout' });
  assert.equal(w.state().rounds.length, 1);

  const stuck = world(t);
  const r = stuck.run(1, { PIPELINE_CODEX_TIMEOUT_MS: '600', FAKE_CODEX_HANG: join(stuck.scratch, 'helper.pid'), ...stuck.ok() });
  assertExit(r, 3, r.stdout);
  assert.deepEqual([r.json.reason, r.json.timedOut, r.json.retried], ['unavailable', true, { reason: 'timeout' }]);
  assert.deepEqual([r.json.substitute.eligible, r.json.substitute.why], [false, 'timed-out']);
  assert.equal(stuck.route().evidence, 'none');
  assert.equal(stuck.route().timedOut, true);
  assert.equal(stuck.record().lastOutage, null);
});

test('a model at capacity is retried once: capacity then success is ok with retried capacity; capacity twice is exit 3 error, never a substitute', (t) => {
  const w = world(t);
  const cap = { PIPELINE_CODEX_CAPACITY_RETRY_MS: '0', FAKE_CODEX_TURN_FAILED: 'Selected model is at capacity. Please try a different model.' };
  const ok = w.run(1, { ...cap, FAKE_CODEX_FAIL_ONCE: join(w.scratch, 'failed-once'), ...w.ok() });
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json.retried, { reason: 'capacity' });
  assert.equal(w.state().rounds.length, 1, 'one counted round');

  const stuck = world(t);
  const r = stuck.run(1, { ...cap, FAKE_CODEX_EXIT: '1', ...stuck.ok() });
  assertExit(r, 3, r.stdout);
  assert.deepEqual([r.json.reason, r.json.timedOut, r.json.retried], ['error', false, { reason: 'capacity' }]);
  assert.equal(r.json.substitute.eligible, false);
  assert.equal(stuck.route().evidence, 'none');
  assert.equal(stuck.record().lastOutage, null);
});

test('overlapping attempts: A starts, B replaces route.json and ends auth, A ends quota => A is superseded (exit 2), route.json stays B\'s, no round, no outage record', { skip: process.platform === 'win32' }, (t) => {
  const w = world(t);
  const b = `FAKE_CODEX_DURING= FAKE_CODEX_TURN_FAILED='Not logged in. Run codex login.' node "${join(process.cwd(), 'pipeline', 'bin', 'pipeline.mjs')}" codex-review --pr 7 --round 1 --base ${w.base} --head ${w.head} --effort high`;
  const a = w.run(1, { ...w.quota(), FAKE_CODEX_DURING: b });
  assertExit(a, 2, a.stdout + a.stderr);
  assert.equal(a.json.error, 'superseded');
  const route = w.route();
  assert.deepEqual([route.evidence, route.reason], ['none', 'auth'], 'B finished first and its evidence stays');
  assert.equal(w.attempts().length, 2);
  assert.ok(w.attempts().includes(`attempt-${route.attemptId}`));
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'no round recorded from A');
  assert.equal(w.record().lastOutage, null, 'the superseded attempt noted no outage');
  assert.equal(readFileSync(join(w.repo.dir, '.review', 'round-1', 'prompt.md'), 'utf8').length > 0, true, 'B (the winner) published its prompt');
});

test('a recorded round: route.json is none/recorded for that attempt, the winner\'s files are copied to round-R, Codex wrote into the attempt folder', (t) => {
  const w = world(t);
  const r = w.run(1, w.ok());
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.retried, undefined);
  const route = w.route();
  assert.deepEqual([route.evidence, route.outcome], ['none', 'recorded']);
  const dir = join(w.repo.dir, '.review', 'round-1');
  assert.deepEqual(readFileSync(join(dir, 'codex-raw.json')), readFileSync(join(dir, `attempt-${route.attemptId}`, 'codex-raw.json')));
  assert.deepEqual(readFileSync(join(dir, 'prompt.md')), readFileSync(join(dir, `attempt-${route.attemptId}`, 'prompt.md')));
  const round = w.state().rounds[0];
  assert.equal(round.risk, 'low');
  assert.equal(w.state().maxRisk, 'low');
  assert.equal(w.state().version, 1, 'an ordinary Codex round does not raise the state version');
});

test('the next Codex answer clears the waiting PR and the last outage (best effort), and a broken record folder is only a warning', async (t) => {
  const w = world(t);
  await recordOutage({ at: '2026-11-11T08:00:00Z', resetAt: null, resetText: null, repo: w.slug, pr: 7, round: 1, worktree: w.repo.dir }, { dir: w.status });
  await addWaiting({ repo: w.slug, pr: 7, worktree: w.repo.dir, round: 1 }, { dir: w.status });
  await addWaiting({ repo: w.slug, pr: 8, worktree: '/elsewhere', round: 2 }, { dir: w.status });
  assert.equal(w.record().waiting.length, 2);
  const r = w.run(1, w.ok());
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(w.record().lastOutage, null);
  assert.deepEqual(w.record().waiting.map((x) => x.pr), [8], 'only this PR is removed');

  const broken = world(t);
  writeFileSync(join(broken.scratch, 'not-a-dir'), 'x');
  const q = broken.run(1, { ...broken.quota(), PIPELINE_CODEX_STATUS_DIR: join(broken.scratch, 'not-a-dir', 'codex') });
  assertExit(q, 3, q.stdout);
  assert.equal(q.json.reason, 'quota');
  assert.equal(q.json.substitute.eligible, true, 'a record that cannot be written never changes the verdict');
  assert.ok(Array.isArray(q.json.warnings) && q.json.warnings.length >= 1, JSON.stringify(q.json));
});

test('substituteEligibility: every refusal has a why, and quotaValidUntilMs gives a record with no reset time 2 hours', () => {
  const quota = { eligible: true, proof: 'session-log', resetAt: '2026-11-11T09:00:00.000Z' };
  const now = Date.parse('2026-11-11T08:00:00Z');
  const base = { reason: 'quota', quota, mode: 'auto', minWaitMinutes: 0, agent: 'substitute-opus', now };
  assert.deepEqual(substituteEligibility(base), { eligible: true, why: 'quota', agent: 'substitute-opus', resetAt: quota.resetAt });
  assert.equal(substituteEligibility({ ...base, timedOut: true }).why, 'timed-out');
  assert.equal(substituteEligibility({ ...base, reason: 'auth' }).why, 'not-quota:auth');
  assert.equal(substituteEligibility({ ...base, mode: 'off' }).why, 'mode-off');
  assert.equal(substituteEligibility({ ...base, quota: { ...quota, eligible: false } }).why, 'quota-unproven');
  assert.equal(substituteEligibility({ ...base, quota: undefined }).why, 'quota-unproven');
  assert.equal(substituteEligibility({ ...base, minWaitMinutes: 90 }).waitUntil, quota.resetAt);
  assert.equal(substituteEligibility({ ...base, minWaitMinutes: 30 }).eligible, true);
  assert.equal(quotaValidUntilMs({ resetAt: quota.resetAt, at: '2026-11-11T07:00:00Z' }), Date.parse(quota.resetAt));
  assert.equal(quotaValidUntilMs({ resetAt: null, at: '2026-11-11T07:00:00Z' }), Date.parse('2026-11-11T07:00:00Z') + OUTAGE_NO_RESET_MS);
});

test('maxRisk: a smaller later diff keeps the PR on substitute-fable (the agent follows maxRisk, not the latest risk)', (t) => {
  const w = world(t, { yml: 'risk:\n  high_risk_paths: ["src/big.js"]\n' });
  assertExit(w.run(1, w.ok()), 0);
  assert.equal(w.state().maxRisk, 'high');
  // round 2 reviews a tiny change that no longer touches the high-risk file in ITS range, but the PR as a whole still does: high stays either way
  w.repo.write('src/fix.js', 'export const fix = 1;\n');
  const h2 = w.repo.commit('fix');
  w.prHead(h2);
  mkdirSync(join(w.repo.dir, '.review'), { recursive: true });
  const r = w.run(2, w.quota(), { from: w.head, to: h2 });
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.substitute.agent, 'substitute-fable');
  assert.equal(w.route(2).risk, 'high');
});
