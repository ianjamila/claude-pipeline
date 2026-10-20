// Timing helpers for "stays linear" tests. A single ms-scale ratio is noise on a shared runner (a Windows CPU clock ticks every
// ~15 ms: 15 ms -> 47 ms once failed a linear scan), so a sample is the BEST of several runs: noise only ever adds time, never
// removes it, and a real quadratic or exponential blow-up stays slow on every run.
//
// CPU caps and timer slack scale with a MACHINE FACTOR: how much slower than the reference Mac this process is (a shared Ubuntu runner
// once took 3x, Windows CI ~4x). Step checks count reads of an injected clock instead of time, so they are the same on every machine.
import assert from 'node:assert/strict';

// CPU time (user + system) `fn` burns, in ms. CPU time ignores the time the OS spent running something else.
export function cpuTime(fn) {
  const t0 = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

// Runs `fn` once; returns its value and the CPU ms it burned. Load-proof like cpuTime, for caps that also need the result.
export function cpuTimed(fn) {
  const t0 = process.cpuUsage();
  const r = fn();
  const d = process.cpuUsage(t0);
  return { r, ms: (d.user + d.system) / 1000 };
}

// The fastest of `runs` samples; `sample()` returns a number of ms.
export function bestOf(runs, sample) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, sample());
  return best;
}

// Asserts that `large()` (`factor` times the input of `small()`, default 2) takes under `ratio` times as long (a linear scan gives ~factor,
// a quadratic one ~factor^2). A wider span (e.g. factor 16, ratio 64: linear 16x, quadratic 256x) absorbs a per-byte cost that climbs
// across several doublings (the input outgrowing the CPU cache) that a single doubling cannot, with 4x margin on each side.
// Both return ms. One warm-up run of `small` is discarded (JIT, caches). The baseline is the best of `smallRuns`; the large run is
// repeated until it passes, at most `largeRuns` times, so a slow sample cannot fail the test but a slow best-of-all cannot pass.
// The check also passes when the excess over a perfectly linear run is below `slackMs` (times `slackFactor`): under the clock's resolution there is
// nothing to measure. Size the inputs so the baseline is well above that slack (tens of ms), or a quadratic one slips through it.
// `slackFactor` (default: the machine factor) scales `slackMs`: the clock's resolution is coarser on a slow machine.
export function assertLinear(small, large, { label = 'work', ratio = 3, slackMs = 25, smallRuns = 3, largeRuns = 5, factor = 2, slackFactor = machineFactor() } = {}) {
  const slack = slackMs * slackFactor;
  small();
  const lo = Math.max(bestOf(smallRuns, small), 1);
  let hi = Infinity;
  for (let i = 0; i < largeRuns; i++) {
    hi = Math.min(hi, large());
    if (hi / lo < ratio || hi - factor * lo < slack) return { lo, hi };
  }
  assert.fail(`${label}: ${Math.round(lo)}ms at n/${factor} -> ${Math.round(hi)}ms at n (best of ${largeRuns}): not linear`);
}

// REF_MS: the best CPU ms of referenceWork() on this Mac (median of 20 fresh processes in two batches of 10, best of 3 each, rounded up; 2026-10-20, Ians-MacBook-Pro-3).
export const REF_MS = 134;
const MIN_FACTOR = 1;
const MAX_FACTOR = 8;

// A fixed workload shaped like guard work: a 1 MB string scanned by char code, regex passes, Map/Set inserts and slicing; it returns a checksum so the JIT cannot drop the work.
export function referenceWork() {
  const unit = 'git commit -m "msg" && echo \'a b\' | sed -e "s/x/y/g" $(ls -la) # note\n';
  let text = '';
  while (text.length < 1_000_000) text += unit;
  let sum = 0;
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i) * (i & 7)) | 0;
    const re = /[a-z]+|"[^"]*"|\$\([^)]*\)/g;
    for (let m; (m = re.exec(text)) !== null && re.lastIndex < 200_000;) sum = (sum + m[0].length) | 0;
    const map = new Map();
    const set = new Set();
    for (let i = 0; i < 20_000; i++) {
      const piece = text.slice(i * 7, i * 7 + 12 + (i & 15));
      map.set(piece + (i & 1023), i);
      set.add(piece.length * 31 + (i & 255));
    }
    sum = (sum + map.size + set.size) | 0;
  }
  return sum;
}

// The factor for a machine whose referenceWork took `bestMs`: the ratio to REF_MS, clamped to [1, 8] (a fast machine never tightens a cap).
// PIPELINE_TIMING_FACTOR overrides the ratio when it is a positive finite number; anything else is ignored.
export function factorFrom(bestMs, env = process.env) {
  const o = Number(env.PIPELINE_TIMING_FACTOR);
  const raw = Number.isFinite(o) && o > 0 ? o : bestMs / REF_MS;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, raw));
}

let cachedFactor;
// Computed lazily, once per process: one discarded warm-up, then the best of 3 CPU samples of referenceWork.
export function machineFactor() {
  if (cachedFactor === undefined) {
    referenceWork();
    cachedFactor = factorFrom(bestOf(3, () => cpuTime(referenceWork)), process.env);
    console.log('# timing factor', cachedFactor);
  }
  return cachedFactor;
}

// A CPU cap of `ms` on the reference Mac, scaled to this machine.
export function cpuCap(ms) {
  return ms * machineFactor();
}

// `ms` of CPU measured for `label` must stay under `baseMs` scaled by the machine factor.
export function assertCpuUnder(ms, baseMs, label) {
  const f = machineFactor();
  const cap = baseMs * f;
  assert.ok(ms < cap, `${label}: ${Math.round(ms)}ms > ${baseMs}ms x${f.toFixed(1)} = ${Math.round(cap)}ms`);
}

// A clock for opts.now: every read advances it by `msPerRead`, so a deadline lands at a fixed number of reads on every machine.
export function virtualClock(msPerRead) {
  const c = { reads: 0, now() { c.reads += 1; return c.reads * msPerRead; } };
  return c;
}

// For opts.expired: false until more than `limitReads` reads have been made.
export function virtualExpired(limitReads) {
  const e = { reads: 0, expired() { e.reads += 1; return e.reads > limitReads; } };
  return e;
}

// A step check: the count was between `floor` (proves the meter sees the work) and `ceil`. `unit` names what is counted in the failure message.
export function assertSteps(reads, { floor, ceil, label, unit = 'clock reads' }) {
  assert.ok(reads >= floor && reads <= ceil, `${label}: ${reads} ${unit}, expected ${floor}..${ceil}`);
}

// Linear scaling in reads: the full-size run reads at most 2.5x the half-size run plus 4. `unit` names what is counted in the failure message.
export function assertLinearSteps(readsHalf, readsFull, label, { unit = 'clock reads' } = {}) {
  assert.ok(readsFull <= 2.5 * readsHalf + 4, `${label}: ${readsFull} ${unit} at n > 2.5 x ${readsHalf} at n/2 + 4`);
}
