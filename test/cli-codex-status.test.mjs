// Why: `pipeline codex-status` is what a session reads before it decides to wait for Codex, and what `--wait` blocks on, so it must (a) print one stable shape whatever
// it can or cannot read, (b) never write anything, and (c) return from --wait exactly when Codex is back: at once when nothing is out, at the reset when something is.
// Plan 2026-11-11-codex-substitute-reviewer, tests (29) and (31).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { run, meta } from '../pipeline/commands/codex-status.mjs';
import { addWaiting, clearOutage, recordOutage, statusFile } from '../pipeline/lib/codex-usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const REAL_LINE = readFileSync(join(here, 'fixtures', 'codex-0.154', 'codex-0.154-token-count-codex.jsonl'), 'utf8').trim();
const EVENT_MS = Date.parse(JSON.parse(REAL_LINE).timestamp);
const NOW = EVENT_MS + 10 * 60_000;
const KEYS = ['ok', 'weeklyUsedPct', 'windowMinutes', 'resetsAt', 'observedAt', 'source', 'lastOutage', 'waiting'];

const world = (t, { withLog = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-cli-codex-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, '.codex');
  mkdirSync(join(codexHome, 'sessions', '2026', '11', '11'), { recursive: true });
  if (withLog) writeFileSync(join(codexHome, 'sessions', '2026', '11', '11', 'rollout-a.jsonl'), `${REAL_LINE}\n`);
  const record = { dir: join(root, 'record') };
  return { root, codexHome, record, env: { CODEX_HOME: codexHome } };
};

// A fake clock: sleep() advances it, and every sleep is recorded.
const fakeClock = (start) => {
  let now = start;
  const sleeps = [];
  return { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, sleeps, set: (v) => { now = v; } };
};

test('prints the whole picture: the weekly figure from the real 0.154 log, the outage and the waiting PRs', async (t) => {
  const w = world(t);
  await recordOutage({ at: '2026-11-11T08:21:00Z', resetAt: '2026-11-11T08:51:00Z', resetText: '4:51 PM', repo: 'o/r', pr: 256, round: 2, worktree: '/w' }, w.record);
  await addWaiting({ repo: 'o/r', pr: 256, worktree: '/w', round: 2, since: '2026-11-11T08:21:00Z' }, w.record);
  const { exitCode, output } = await run([], { env: w.env, record: w.record, now: () => NOW });
  assert.equal(exitCode, 0);
  assert.deepEqual(Object.keys(output), KEYS);
  assert.deepEqual([output.ok, output.weeklyUsedPct, output.windowMinutes, output.source, output.observedAt], [true, 4, 10080, 'codex-sessions', '2026-11-11T08:38:37.899Z']);
  assert.equal(output.resetsAt, '2026-11-18T08:22:03.000Z');
  assert.equal(output.lastOutage.resetText, '4:51 PM');
  assert.equal(output.waiting[0].resume, 'resume the review of o/r#256 from round 2 in /w');
});

test('unreadable telemetry is source unknown with null figures, exit 0, and the record is still shown', async (t) => {
  const w = world(t, { withLog: false });
  await addWaiting({ repo: 'o/r', pr: 1, worktree: '/w', round: 1, since: '2026-11-11T08:21:00Z' }, w.record);
  const { exitCode, output } = await run([], { env: w.env, record: w.record, now: () => NOW });
  assert.equal(exitCode, 0);
  assert.deepEqual(Object.keys(output), KEYS);
  assert.deepEqual([output.ok, output.weeklyUsedPct, output.windowMinutes, output.resetsAt, output.observedAt, output.source, output.lastOutage], [true, null, null, null, null, 'unknown', null]);
  assert.equal(output.waiting.length, 1);
  const none = world(t, { withLog: false });
  assert.equal((await run([], { env: { CODEX_HOME: join(none.root, 'missing') }, record: none.record, now: () => NOW })).output.source, 'unknown');
});

test('reading writes nothing: no record file, no folder, and the session logs are untouched', async (t) => {
  const w = world(t);
  const before = readFileSync(join(w.codexHome, 'sessions', '2026', '11', '11', 'rollout-a.jsonl'), 'utf8');
  await run([], { env: w.env, record: w.record, now: () => NOW });
  await run(['--wait', '--timeout-minutes', '1'], { env: w.env, record: w.record, now: () => NOW, sleep: async () => {} });
  assert.equal(existsSync(w.record.dir), false);
  assert.equal(readFileSync(join(w.codexHome, 'sessions', '2026', '11', '11', 'rollout-a.jsonl'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(w.codexHome, 'sessions', '2026', '11', '11')), ['rollout-a.jsonl']);
});

test('--wait returns at once, without sleeping, when nothing is out', async (t) => {
  const w = world(t);
  const clock = fakeClock(NOW);
  const { exitCode, output } = await run(['--wait'], { env: w.env, record: w.record, ...clock });
  assert.equal(exitCode, 0);
  assert.deepEqual(clock.sleeps, []);
  assert.deepEqual(output.waited, { outage: false, backAt: null, waitedMs: 0, timedOut: false });
  assert.equal(output.ok, true);
  assert.equal(output.weeklyUsedPct, 4);
});

test('--wait with a past outage also returns at once', async (t) => {
  const w = world(t);
  await recordOutage({ at: '2026-11-11T05:00:00Z', resetAt: '2026-11-11T06:00:00Z', repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w.record);
  const clock = fakeClock(NOW);
  const { exitCode, output } = await run(['--wait'], { env: w.env, record: w.record, ...clock });
  assert.equal(exitCode, 0);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(output.waited.outage, false);
});

test('--wait polls every 60 s and returns once the outage resetAt has passed', async (t) => {
  const w = world(t);
  const resetMs = NOW + 150_000; // 2.5 min ahead
  await recordOutage({ at: new Date(NOW).toISOString(), resetAt: new Date(resetMs).toISOString(), resetText: 'soon', repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w.record);
  const clock = fakeClock(NOW);
  const { exitCode, output } = await run(['--wait'], { env: w.env, record: w.record, ...clock });
  assert.equal(exitCode, 0);
  assert.deepEqual(clock.sleeps, [60_000, 60_000, 30_000], 'sleeps in 60 s steps, the last one only as long as is left');
  assert.ok(clock.now() >= resetMs);
  assert.equal(output.waited.outage, true);
  assert.equal(output.waited.backAt, new Date(resetMs).toISOString());
  assert.equal(output.waited.waitedMs, 150_000);
  assert.equal(output.waited.timedOut, false);
});

test('--wait stops waiting as soon as the outage is cleared in the record', async (t) => {
  const w = world(t);
  await recordOutage({ at: new Date(NOW).toISOString(), resetAt: new Date(NOW + 3600_000).toISOString(), repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w.record);
  const clock = fakeClock(NOW);
  let n = 0;
  const sleep = async (ms) => {
    await clock.sleep(ms);
    if (++n === 2) await clearOutage(w.record);
  };
  const { exitCode, output } = await run(['--wait'], { env: w.env, record: w.record, now: clock.now, sleep });
  assert.equal(exitCode, 0);
  assert.equal(n, 2);
  assert.equal(output.lastOutage, null);
});

test('--wait with the week used up (>= 100 %) waits for resetsAt; an outage with no reset time counts for 2 h', async (t) => {
  const w = world(t);
  const full = JSON.parse(REAL_LINE);
  full.payload.rate_limits.primary.used_percent = 100;
  full.payload.rate_limits.primary.resets_at = Math.floor((NOW + 90_000) / 1000);
  writeFileSync(join(w.codexHome, 'sessions', '2026', '11', '11', 'rollout-a.jsonl'), `${JSON.stringify(full)}\n`);
  const clock = fakeClock(NOW);
  const r1 = await run(['--wait'], { env: w.env, record: w.record, ...clock });
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.output.waited.backAt, new Date(Math.floor((NOW + 90_000) / 1000) * 1000).toISOString());
  assert.equal(r1.output.source, 'unknown', 'once the reset has passed the old reading is no longer current');
  assert.ok(clock.now() >= Math.floor((NOW + 90_000) / 1000) * 1000);
  assert.equal(clock.sleeps.length, 2);

  const w2 = world(t, { withLog: false });
  await recordOutage({ at: new Date(NOW).toISOString(), resetAt: null, resetText: null, repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w2.record);
  const c2 = fakeClock(NOW);
  const r2 = await run(['--wait'], { env: w2.env, record: w2.record, ...c2 });
  assert.equal(r2.exitCode, 0);
  assert.equal(c2.now() - NOW, 2 * 3600_000);
});

test('--wait times out (exit 1, ok:false, timedOut) after --timeout-minutes', async (t) => {
  const w = world(t);
  await recordOutage({ at: new Date(NOW).toISOString(), resetAt: new Date(NOW + 3 * 3600_000).toISOString(), repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w.record);
  const clock = fakeClock(NOW);
  const { exitCode, output } = await run(['--wait', '--timeout-minutes', '5'], { env: w.env, record: w.record, ...clock });
  assert.equal(exitCode, 1);
  assert.equal(output.ok, false);
  assert.equal(output.waited.timedOut, true);
  assert.equal(output.waited.waitedMs, 5 * 60_000);
  assert.equal(output.lastOutage.pr, 1);
});

test('usage errors: --timeout-minutes without --wait, a non-number, an unknown flag, a positional', async (t) => {
  const w = world(t);
  const ctx = { env: w.env, record: w.record, now: () => NOW };
  for (const argv of [['--timeout-minutes', '5'], ['--wait', '--timeout-minutes', 'x'], ['--wait', '--timeout-minutes', '0'], ['--nope'], ['extra']]) {
    await assert.rejects(run(argv, ctx), UsageError, argv.join(' '));
  }
});

test('through the real CLI: prints one JSON object; --wait follows a real outage that ends in a moment (poll interval from the test seam)', async (t) => {
  const w = world(t, { withLog: false });
  const env = { ...process.env, ...w.env, PIPELINE_CODEX_STATUS_DIR: w.record.dir, PIPELINE_CODEX_STATUS_POLL_MS: '50' };
  const first = spawnSync(process.execPath, [bin, 'codex-status'], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(Object.keys(JSON.parse(first.stdout)), KEYS);
  assert.equal(JSON.parse(first.stdout).source, 'unknown');
  await recordOutage({ at: new Date().toISOString(), resetAt: new Date(Date.now() + 700).toISOString(), repo: 'o/r', pr: 1, round: 1, worktree: '/w' }, w.record);
  const started = Date.now();
  const waited = spawnSync(process.execPath, [bin, 'codex-status', '--wait'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(waited.status, 0, waited.stderr);
  const out = JSON.parse(waited.stdout);
  assert.equal(out.waited.outage, true);
  assert.ok(Date.now() - started >= 500, 'it really waited for the reset');
  assert.ok(existsSync(statusFile(w.record)));
});

test('meta: summary and usage are text, and the usage names the two forms', () => {
  assert.equal(typeof meta.summary, 'string');
  assert.match(meta.usage, /^pipeline codex-status /m);
  assert.match(meta.usage, /^pipeline codex-status --wait/m);
});
