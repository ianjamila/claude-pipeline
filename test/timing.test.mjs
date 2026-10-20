// The linearity helper must keep its power (a quadratic run fails) while ignoring noise (one slow sample, a tiny excess).
// The "clock" here is fake (numbers computed from the size), so these tests cannot flake themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCpuUnder, assertLinear, assertLinearSteps, assertSteps, bestOf, cpuCap, cpuTime, cpuTimed, factorFrom, machineFactor, REF_MS, referenceWork, virtualClock, virtualExpired } from './helpers/timing.mjs';
import { checkDeadline, GuardLimit, newEvalBudget } from '../pipeline/hooks/lib/script-candidates.mjs';

const fake = (cost, n) => () => cost(n);

test('assertLinear: a linear cost passes', () => {
  assert.doesNotThrow(() => assertLinear(fake((n) => n / 1000, 100_000), fake((n) => n / 1000, 200_000), { slackFactor: 1 }));
});

test('assertLinear: a quadratic cost fails at a baseline of 50 ms (4x for double the input)', () => {
  const sq = (n) => (n * n) / 200_000_000; // 50 ms at n = 100k, 200 ms at n = 200k
  assert.throws(() => assertLinear(fake(sq, 100_000), fake(sq, 200_000), { label: 'fake', slackFactor: 1 }), /fake: 50ms at n\/2 -> 200ms at n .*not linear/);
});

test('assertLinear: an exponential-looking blow-up fails too', () => {
  assert.throws(() => assertLinear(fake(() => 40, 0), fake(() => 4000, 0), { slackFactor: 1 }), /not linear/);
});

test('assertLinear: a quadratic cost is still caught when the large run is only 3.5x slower', () => {
  assert.throws(() => assertLinear(() => 60, () => 210, { slackFactor: 1 }), /not linear/); // ratio 3.5 and 90 ms of excess
});

test('assertLinear: a slow first large sample is retried; every large sample slow still fails', () => {
  const samples = [900, 130, 120];
  assert.doesNotThrow(() => assertLinear(() => 50, () => samples.shift(), { slackFactor: 1 })); // 120/50 = 2.4
  assert.throws(() => assertLinear(() => 50, () => 900, { slackFactor: 1 }), /not linear/);
});

test('assertLinear: the baseline is the best of several runs, so one slow baseline cannot hide a quadratic', () => {
  const baselines = [500, 500, 50, 500]; // the warm-up, then three samples: the best is 50
  assert.throws(() => assertLinear(() => baselines.shift(), () => 200, { slackFactor: 1 }), /50ms at n\/2/);
});

test('assertLinear: below the timer slack (a few ms of excess) nothing is measurable, so it passes', () => {
  assert.doesNotThrow(() => assertLinear(() => 2, () => 20, { slackFactor: 1 })); // ratio 10 but only 16 ms over linear
  assert.throws(() => assertLinear(() => 20, () => 100, { slackFactor: 1 }), /not linear/); // 60 ms over linear
});

test('assertLinear factor 4: a linear cost with a one-off 1.5x cache step (50 -> 300) passes with ratio 8', () => {
  assert.doesNotThrow(() => assertLinear(() => 50, () => 300, { factor: 4, ratio: 8, slackFactor: 1 })); // 6x for 4x the input
});

test('assertLinear factor 4: a quadratic cost (50 -> 800) fails and the message says n/4', () => {
  assert.throws(() => assertLinear(() => 50, () => 800, { factor: 4, ratio: 8, label: 'fake', slackFactor: 1 }), /fake: 50ms at n\/4 -> 800ms at n .*not linear/);
});

test('assertLinear factor 16: a linear cost with a 2.5x per-byte cache climb (20 -> 800) passes; a quadratic (20 -> 5120) fails and names n/16', () => {
  assert.doesNotThrow(() => assertLinear(() => 20, () => 800, { factor: 16, ratio: 64, slackFactor: 1 })); // 40x for 16x the input
  assert.throws(() => assertLinear(() => 20, () => 5120, { factor: 16, ratio: 64, label: 'fake', slackFactor: 1 }), /fake: 20ms at n\/16 -> 5120ms at n .*not linear/);
});

test('assertLinear: the default factor still reports n/2', () => {
  assert.throws(() => assertLinear(() => 50, () => 800, { slackFactor: 1 }), /50ms at n\/2 -> 800ms at n/);
});

test('assertLinear factor 4: the slack is measured over 4x the baseline', () => {
  assert.doesNotThrow(() => assertLinear(() => 2, () => 20, { factor: 4, ratio: 8, slackFactor: 1 })); // 12 ms over linear
  assert.doesNotThrow(() => assertLinear(() => 2, () => 31, { factor: 4, ratio: 8, slackFactor: 1 })); // 23 ms over linear (27 at factor 2 would fail)
  assert.throws(() => assertLinear(() => 2, () => 31, { slackFactor: 1 }), /not linear/);
  assert.throws(() => assertLinear(() => 20, () => 200, { factor: 4, ratio: 8, slackFactor: 1 }), /not linear/); // ratio 10, 120 ms over linear
});

test('bestOf takes the minimum; cpuTime measures a callback in ms', () => {
  const xs = [5, 2, 9];
  assert.equal(bestOf(3, () => xs.shift()), 2);
  const ms = cpuTime(() => { const end = Date.now() + 30; while (Date.now() < end) { /* burn CPU */ } });
  assert.ok(ms > 0);
});

test("cpuTimed returns fn's value; CPU burn counts, a sleep does not (so machine load cannot trip a cap)", () => {
  assert.equal(cpuTimed(() => 42).r, 42);
  const burn = cpuTimed(() => { const t0 = process.cpuUsage(); let x = 0; for (;;) { const d = process.cpuUsage(t0); if (d.user + d.system >= 50_000) return x; x++; } });
  assert.ok(burn.ms >= 30, `50 ms of CPU read ${burn.ms} ms`);
  const sleep = cpuTimed(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50));
  assert.ok(sleep.ms < 25, `a 50 ms sleep read ${sleep.ms} ms of CPU`);
  assert.ok(sleep.ms < burn.ms);
});

test('assertLinear slackFactor: the timer slack scales with the machine factor', () => {
  assert.doesNotThrow(() => assertLinear(() => 50, () => 200, { slackFactor: 8 })); // 100 ms over linear, under 25 x 8
  assert.throws(() => assertLinear(() => 50, () => 200, { slackFactor: 1 }), /not linear/);
});

test('factorFrom: the ratio to REF_MS, never below 1, never above 8', () => {
  assert.equal(factorFrom(REF_MS / 2, {}), 1);
  assert.equal(factorFrom(3 * REF_MS, {}), 3);
  assert.equal(factorFrom(100 * REF_MS, {}), 8);
});

test('factorFrom: PIPELINE_TIMING_FACTOR overrides when positive and finite, clamped; anything else falls back to the ratio', () => {
  assert.equal(factorFrom(REF_MS, { PIPELINE_TIMING_FACTOR: '4' }), 4);
  assert.equal(factorFrom(REF_MS, { PIPELINE_TIMING_FACTOR: '0.5' }), 1);
  assert.equal(factorFrom(REF_MS, { PIPELINE_TIMING_FACTOR: '99' }), 8);
  for (const bad of ['abc', '-2', '0', 'Infinity']) assert.equal(factorFrom(4 * REF_MS, { PIPELINE_TIMING_FACTOR: bad }), 4, bad);
});

test('machineFactor is memoized and cpuCap multiplies by it', () => {
  const f = machineFactor();
  assert.ok(f >= 1 && f <= 8);
  assert.equal(machineFactor(), f);
  assert.equal(cpuCap(1000), 1000 * f);
});

test('referenceWork is deterministic', () => {
  assert.equal(referenceWork(), referenceWork());
});

test('assertCpuUnder names the measurement, the base cap, the factor and the scaled cap', () => {
  assert.throws(() => assertCpuUnder(1e9, 5, 'x'), /x: 1000000000ms > 5ms x[\d.]+ = [\d.]+ms/);
  assert.doesNotThrow(() => assertCpuUnder(0, 5, 'x'));
});

test('virtualClock counts reads; an evaluation budget on it expires at a fixed read count', () => {
  const c = virtualClock(10);
  assert.deepEqual([c.now(), c.now(), c.now()], [10, 20, 30]);
  assert.equal(c.reads, 3);
  const k = virtualClock(10);
  const budget = newEvalBudget(k.now); // read 1: deadline = 10 + 5000
  for (let i = 0; i < 500; i++) checkDeadline(budget); // reads 2..501: 20 .. 5010 are not past 5010
  assert.throws(() => checkDeadline(budget), GuardLimit); // read 502
  assert.equal(k.reads, 502);
});

test('virtualExpired: false until the read count passes the limit', () => {
  const e = virtualExpired(2);
  assert.deepEqual([e.expired(), e.expired(), e.expired()], [false, false, true]);
  assert.equal(e.reads, 3);
});

test('assertSteps: the count must sit between floor and ceiling and the message names the label', () => {
  assert.throws(() => assertSteps(0, { floor: 1, ceil: 10, label: 'z' }), /z: 0 clock reads/);
  assert.throws(() => assertSteps(11, { floor: 1, ceil: 10, label: 'z' }), /z: 11 clock reads/);
  assert.doesNotThrow(() => assertSteps(5, { floor: 1, ceil: 10, label: 'z' }));
  assert.doesNotThrow(() => assertSteps(1, { floor: 1, ceil: 10, label: 'z' }));
  assert.doesNotThrow(() => assertSteps(10, { floor: 1, ceil: 10, label: 'z' }));
});

test('assertLinearSteps: at most 2.5x the half-size count plus 4', () => {
  assert.throws(() => assertLinearSteps(10, 30, 'q'), /q:/);
  assert.doesNotThrow(() => assertLinearSteps(10, 24, 'q'));
  assert.doesNotThrow(() => assertLinearSteps(10, 29, 'q'));
});
