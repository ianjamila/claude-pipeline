// Retry of GitHub rate limits, for whole IDEMPOTENT operations only (#190 item 5). `retrying(fn)` re-runs fn from its
// start, so fn must re-read what it is about to write on every attempt (upsertComment re-lists its marker comments, the
// follow-up create re-reads the issues it deduplicates against). Safety rests on that re-read, not on GitHub having
// rejected the request before running it.
//
// It is NOT a default of every gh call: merge, merge hold, merge queue, update-branch, the final gate and the hooks keep
// their no-retry, no-sleep behaviour (a signal handler or a hold's cleanup must never block on a sleep).
//
// What is retried: a non-zero gh exit that is not a timeout or an over-buffer cut, whose text names a secondary or primary
// rate limit (a 403 only with "rate limit" in it). A plain 403 (permission), a timeout, a 5xx and a network error are never
// retried: those may have executed, or will not change by waiting.
export const DEFAULT_CAP_MS = 100_000; // under the 2-minute default Bash timeout of the agent that runs us
export const SECONDARY_WAIT_MS = 60_000; // GitHub documents "wait at least one minute" for a secondary limit
const MAX_ATTEMPTS = 8; // a belt for the case where every wait is 0

const SECONDARY = /secondary rate limit|abuse detection|submitted too quickly/i;
const PRIMARY = /API rate limit (already )?exceeded|HTTP 429/i;

const textOf = (r) => `${r?.stderr ?? ''}\n${r?.stdout ?? ''}`;

// `r` is a gh result or a GhError (both carry code, stderr, stdout, timedOut, overBuffer).
export function isRateLimited(r) {
  if (!r || typeof r.code !== 'number' || r.code === 0 || r.timedOut || r.overBuffer === true) return false;
  const text = textOf(r);
  if (SECONDARY.test(text) || PRIMARY.test(text)) return true;
  return /HTTP 403|"status"\s*:\s*"?403/.test(text) && /rate limit/i.test(text);
}

const isSecondary = (r) => SECONDARY.test(textOf(r)) || (/HTTP 429/i.test(textOf(r)) && !/API rate limit (already )?exceeded/i.test(textOf(r)));

// `Retry-After: N` (seconds), visible only when gh printed headers (-i / GH_DEBUG=api). null when absent.
export function retryAfterMs(r) {
  const m = /retry-after:\s*(\d+)/i.exec(textOf(r));
  return m ? Number(m[1]) * 1000 : null;
}

// The retry cap in ms: the default (or `maxMs`), which PIPELINE_GH_RETRY_MS can only SHORTEN; 0 switches retrying off.
export function retryCapMs(env, maxMs = DEFAULT_CAP_MS) {
  const base = Number.isFinite(maxMs) && maxMs >= 0 ? maxMs : DEFAULT_CAP_MS;
  const raw = env?.PIPELINE_GH_RETRY_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return base;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.min(base, v) : base;
}

export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The earliest reset (epoch ms) among the resources with nothing left, from `gh api rate_limit` (a call GitHub does not
// count). null when none is exhausted or the answer is unreadable. `exec` runs gh WITHOUT retrying.
export function earliestExhaustedReset(exec) {
  let r;
  try {
    r = exec(['api', 'rate_limit']);
    if (r.code !== 0 || r.timedOut) return null;
    const resources = JSON.parse(r.stdout)?.resources ?? {};
    const resets = Object.values(resources)
      .filter((x) => x && Number(x.remaining) === 0 && Number.isFinite(Number(x.reset)))
      .map((x) => Number(x.reset) * 1000);
    return resets.length ? Math.min(...resets) : null;
  } catch {
    return null;
  }
}

const seconds = (ms) => Math.ceil(ms / 1000);

// Runs fn(attempt) (attempt counts from 1). On a rate-limit GhError waits and runs it again, spending at most `maxMs` of
// waiting in total; then the last error is thrown. `probe()` returns the earliest reset (epoch ms) of an exhausted resource.
// `budget` ({ waited }) is the waiting already spent: a caller that shares one object across calls (makeRetrier) makes the cap cumulative.
export function retrying(fn, { sleep = sleepSync, now = Date.now, maxMs = DEFAULT_CAP_MS, log = (line) => process.stderr.write(`${line}\n`), probe = () => null, budget = { waited: 0 } } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn(attempt);
    } catch (err) {
      if (maxMs <= 0 || attempt >= MAX_ATTEMPTS || !isRateLimited(err)) throw err;
      const left = maxMs - budget.waited;
      let wait;
      let why;
      const hinted = retryAfterMs(err);
      if (hinted !== null) {
        wait = hinted;
        why = `Retry-After ${seconds(hinted)} s`;
      } else if (isSecondary(err)) {
        wait = Math.min(SECONDARY_WAIT_MS, left); // then the rest of the cap
        why = 'secondary rate limit';
      } else {
        const reset = probe();
        if (reset === null) {
          wait = Math.min(SECONDARY_WAIT_MS, left); // reset unknown (or already past): a short wait, not a guess at the reset
          why = 'rate limit, reset unknown';
        } else {
          wait = Math.max(0, reset - now()) + 1000;
          why = `rate limit resets at ${new Date(reset).toISOString()}`;
        }
      }
      if (wait > left || left <= 0) {
        err.message = `${err.message}\n(${why}: a ${seconds(wait)} s wait does not fit the ${seconds(maxMs)} s retry cap, so it is not retried; ${seconds(budget.waited)} s already waited)`;
        throw err;
      }
      log(`gh: ${why}; retrying in ${seconds(wait)} s (${seconds(budget.waited + wait)} of ${seconds(maxMs)} s retry cap)`);
      sleep(wait);
      budget.waited += wait;
    }
  }
}

// What createGitHub wires in: a retrying() bound to this gh runner. `exec` runs gh without retrying (for the rate_limit probe).
// The cap is ONE budget per retrier (per createGitHub instance): two rate-limited operations of one command together wait at most the cap (#266 R1-F2).
export function makeRetrier({ exec, env, retry = {} }) {
  const maxMs = retryCapMs(env, retry.maxMs);
  const budget = { waited: 0 };
  let active = false; // a nested retrying() just runs: the outermost one owns the cap
  return (fn) => {
    if (active || maxMs <= 0) return fn(1);
    active = true;
    try {
      return retrying(fn, { sleep: retry.sleep, now: retry.now, log: retry.log, maxMs, budget, probe: () => earliestExhaustedReset(exec) });
    } finally {
      active = false;
    }
  };
}
