import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError } from '../pipeline/lib/proc.mjs';
import { retrying, isRateLimited, retryAfterMs, retryCapMs, earliestExhaustedReset, DEFAULT_CAP_MS } from '../pipeline/lib/gh-retry.mjs';

const limited = (stderr, extra = {}) => Object.assign(new GhError({ code: 1, stderr, args: ['api', 'x'] }), { stdout: '', ...extra });
const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)';
const harness = (over = {}) => {
  const waits = [];
  const logs = [];
  return { waits, logs, opts: { sleep: (ms) => waits.push(ms), log: (l) => logs.push(l), now: () => 0, ...over } };
};

test('isRateLimited: the messages GitHub uses, and only those', () => {
  assert.equal(isRateLimited(limited(SECONDARY)), true);
  assert.equal(isRateLimited(limited('gh: was submitted too quickly')), true);
  assert.equal(isRateLimited(limited('gh: API rate limit exceeded for user ID 1. (HTTP 403)')), true);
  assert.equal(isRateLimited(limited('gh: API rate limit already exceeded (HTTP 429)')), true);
  assert.equal(isRateLimited(limited('gh: abuse detection mechanism (HTTP 403)')), true);
  assert.equal(isRateLimited(limited('gh: Too Many Requests (HTTP 429)')), true);
  assert.equal(isRateLimited(limited('gh: Resource not accessible by integration (HTTP 403)')), false, 'a permission 403 never retries');
  assert.equal(isRateLimited(limited('gh: Bad gateway (HTTP 502)')), false);
  assert.equal(isRateLimited(limited(SECONDARY, { timedOut: true })), false);
  assert.equal(isRateLimited(limited(SECONDARY, { overBuffer: true })), false);
  assert.equal(isRateLimited({ code: 0, stderr: SECONDARY }), false);
});

test('retryAfterMs reads Retry-After seconds when gh printed headers', () => {
  assert.equal(retryAfterMs(limited(`${SECONDARY}\nRetry-After: 7`)), 7000);
  assert.equal(retryAfterMs(limited(SECONDARY)), null);
});

test('retryCapMs: PIPELINE_GH_RETRY_MS can only shorten the default; 0 is off', () => {
  assert.equal(retryCapMs({}), DEFAULT_CAP_MS);
  assert.equal(retryCapMs({ PIPELINE_GH_RETRY_MS: '5000' }), 5000);
  assert.equal(retryCapMs({ PIPELINE_GH_RETRY_MS: '0' }), 0);
  assert.equal(retryCapMs({ PIPELINE_GH_RETRY_MS: '99999999' }), DEFAULT_CAP_MS, 'larger than the default is ignored');
  assert.equal(retryCapMs({ PIPELINE_GH_RETRY_MS: 'soon' }), DEFAULT_CAP_MS);
});

test('secondary limit twice then success: waits 60 s, then the rest of the 100 s cap', () => {
  const h = harness();
  let calls = 0;
  const out = retrying(() => { calls += 1; if (calls < 3) throw limited(SECONDARY); return 'done'; }, h.opts);
  assert.equal(out, 'done');
  assert.deepEqual(h.waits, [60_000, 40_000]);
  assert.equal(h.logs.length, 2, 'one stderr line per wait');
  assert.match(h.logs[0], /retrying in 60 s \(60 of 100 s retry cap\)/);
  assert.match(h.logs[1], /retrying in 40 s \(100 of 100 s retry cap\)/);
});

test('cap spent: the last error is thrown with its stderr', () => {
  const h = harness();
  let calls = 0;
  assert.throws(() => retrying(() => { calls += 1; throw limited(SECONDARY); }, h.opts), (e) => e instanceof GhError && /secondary rate limit/.test(e.stderr) && /retry cap/.test(e.message));
  assert.equal(calls, 3);
  assert.deepEqual(h.waits, [60_000, 40_000]);
});

test('Retry-After is honoured', () => {
  const h = harness();
  let calls = 0;
  retrying(() => { calls += 1; if (calls === 1) throw limited(`${SECONDARY}\nRetry-After: 7`); }, h.opts);
  assert.deepEqual(h.waits, [7000]);
});

test('a permission 403 and a timeout are one call, no sleep', () => {
  for (const err of [limited('gh: Resource not accessible by integration (HTTP 403)'), limited(SECONDARY, { timedOut: true }), limited('gh: HTTP 502')]) {
    const h = harness();
    let calls = 0;
    assert.throws(() => retrying(() => { calls += 1; throw err; }, h.opts), GhError);
    assert.equal(calls, 1);
    assert.deepEqual(h.waits, []);
  }
});

test('maxMs 0 is off', () => {
  const h = harness({ maxMs: 0 });
  let calls = 0;
  assert.throws(() => retrying(() => { calls += 1; throw limited(SECONDARY); }, h.opts), GhError);
  assert.equal(calls, 1);
  assert.deepEqual(h.waits, []);
});

test('a non-gh error passes straight through', () => {
  const h = harness();
  let calls = 0;
  assert.throws(() => retrying(() => { calls += 1; throw new TypeError('bug'); }, h.opts), TypeError);
  assert.equal(calls, 1);
});

const PRIMARY = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)';

test('primary limit: waits for the reset when it fits the cap', () => {
  const h = harness({ now: () => 1_000_000, probe: () => 1_030_000 });
  let calls = 0;
  retrying(() => { calls += 1; if (calls === 1) throw limited(PRIMARY); }, h.opts);
  assert.deepEqual(h.waits, [31_000]);
  assert.match(h.logs[0], /resets at 1970-01-01T00:17:10\.000Z/);
});

test('primary limit: a reset beyond the cap throws at once naming the reset time', () => {
  const h = harness({ now: () => 0, probe: () => 3_600_000 });
  let calls = 0;
  assert.throws(() => retrying(() => { calls += 1; throw limited(PRIMARY); }, h.opts), (e) => /resets at 1970-01-01T01:00:00\.000Z/.test(e.message) && /rate limit exceeded/.test(e.stderr));
  assert.equal(calls, 1);
  assert.deepEqual(h.waits, []);
});

test('earliestExhaustedReset picks the earliest reset among exhausted resources (graphql before core)', () => {
  const body = { resources: { core: { remaining: 0, reset: 2000 }, graphql: { remaining: 0, reset: 1500 }, search: { remaining: 30, reset: 100 } } };
  assert.equal(earliestExhaustedReset(() => ({ code: 0, stdout: JSON.stringify(body) })), 1_500_000);
  assert.equal(earliestExhaustedReset(() => ({ code: 0, stdout: JSON.stringify({ resources: { core: { remaining: 5, reset: 9 } } }) })), null);
  assert.equal(earliestExhaustedReset(() => ({ code: 1, stdout: '' })), null);
  assert.equal(earliestExhaustedReset(() => ({ code: 0, stdout: 'nope' })), null);
});
