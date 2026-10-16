// The linearity helper must keep its power (a quadratic run fails) while ignoring noise (one slow sample, a tiny excess).
// The "clock" here is fake (numbers computed from the size), so these tests cannot flake themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLinear, bestOf, cpuTime, cpuTimed } from './helpers/timing.mjs';

const fake = (cost, n) => () => cost(n);

test('assertLinear: a linear cost passes', () => {
  assert.doesNotThrow(() => assertLinear(fake((n) => n / 1000, 100_000), fake((n) => n / 1000, 200_000)));
});

test('assertLinear: a quadratic cost fails at a baseline of 50 ms (4x for double the input)', () => {
  const sq = (n) => (n * n) / 200_000_000; // 50 ms at n = 100k, 200 ms at n = 200k
  assert.throws(() => assertLinear(fake(sq, 100_000), fake(sq, 200_000), { label: 'fake' }), /fake: 50ms at n\/2 -> 200ms at n .*not linear/);
});

test('assertLinear: an exponential-looking blow-up fails too', () => {
  assert.throws(() => assertLinear(fake(() => 40, 0), fake(() => 4000, 0)), /not linear/);
});

test('assertLinear: a quadratic cost is still caught when the large run is only 3.5x slower', () => {
  assert.throws(() => assertLinear(() => 60, () => 210), /not linear/); // ratio 3.5 and 90 ms of excess
});

test('assertLinear: a slow first large sample is retried; every large sample slow still fails', () => {
  const samples = [900, 130, 120];
  assert.doesNotThrow(() => assertLinear(() => 50, () => samples.shift())); // 120/50 = 2.4
  assert.throws(() => assertLinear(() => 50, () => 900), /not linear/);
});

test('assertLinear: the baseline is the best of several runs, so one slow baseline cannot hide a quadratic', () => {
  const baselines = [500, 500, 50, 500]; // the warm-up, then three samples: the best is 50
  assert.throws(() => assertLinear(() => baselines.shift(), () => 200), /50ms at n\/2/);
});

test('assertLinear: below the timer slack (a few ms of excess) nothing is measurable, so it passes', () => {
  assert.doesNotThrow(() => assertLinear(() => 2, () => 20)); // ratio 10 but only 16 ms over linear
  assert.throws(() => assertLinear(() => 20, () => 100), /not linear/); // 60 ms over linear
});

test('assertLinear factor 4: a linear cost with a one-off 1.5x cache step (50 -> 300) passes with ratio 8', () => {
  assert.doesNotThrow(() => assertLinear(() => 50, () => 300, { factor: 4, ratio: 8 })); // 6x for 4x the input
});

test('assertLinear factor 4: a quadratic cost (50 -> 800) fails and the message says n/4', () => {
  assert.throws(() => assertLinear(() => 50, () => 800, { factor: 4, ratio: 8, label: 'fake' }), /fake: 50ms at n\/4 -> 800ms at n .*not linear/);
});

test('assertLinear factor 16: a linear cost with a 2.5x per-byte cache climb (20 -> 800) passes; a quadratic (20 -> 5120) fails and names n/16', () => {
  assert.doesNotThrow(() => assertLinear(() => 20, () => 800, { factor: 16, ratio: 64 })); // 40x for 16x the input
  assert.throws(() => assertLinear(() => 20, () => 5120, { factor: 16, ratio: 64, label: 'fake' }), /fake: 20ms at n\/16 -> 5120ms at n .*not linear/);
});

test('assertLinear: the default factor still reports n/2', () => {
  assert.throws(() => assertLinear(() => 50, () => 800), /50ms at n\/2 -> 800ms at n/);
});

test('assertLinear factor 4: the slack is measured over 4x the baseline', () => {
  assert.doesNotThrow(() => assertLinear(() => 2, () => 20, { factor: 4, ratio: 8 })); // 12 ms over linear
  assert.doesNotThrow(() => assertLinear(() => 2, () => 31, { factor: 4, ratio: 8 })); // 23 ms over linear (27 at factor 2 would fail)
  assert.throws(() => assertLinear(() => 2, () => 31), /not linear/);
  assert.throws(() => assertLinear(() => 20, () => 200, { factor: 4, ratio: 8 }), /not linear/); // ratio 10, 120 ms over linear
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
