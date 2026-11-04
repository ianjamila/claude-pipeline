// `pipeline ci-wait`: decide WHEN a PR's required CI is done, so the hand-off after `gh pr ready` is not early. A pure state
// machine: everything external (GitHub reads, the clock, sleeping, progress output) is injected, so the Phase 6 race can be
// replayed in tests with a simulated clock.
//
// The bug it fixes (Phase 6, EW #1631): right after `gh pr ready` the head's only run of `Typecheck + Vitest` is the
// draft-era SKIPPED one until the `ready_for_review` run exists. Counting that skip as done released the hand-off ~14 min early.
//
// Role: ci-wait is not the merge authority. Producer provenance (guard statuses posted by the pipeline-guards workflow,
// required rows) is re-proved by `pipeline merge`'s live gate (finalgate.mjs ciCheck) and by GitHub branch protection before
// any merge. ci-wait never reports success on evidence it knows to be incomplete: an unreadable policy source is `unverified`.
//
// Freshness is judged for SKIPPED and for FAILED / CANCELLED results. A skip or a failure that predates the ready event is
// draft-era (`stale-skip` / `stale-fail`): the check keeps waiting for its ready-era result, up to --appear-timeout. A stale
// failure never re-posted then stands as `failed` (marked "result predates ready"); a fresh failure ends the wait at once. This
// matters on EW, where the `Cross-model review` status is a draft-era FAILURE until it is re-posted after `gh pr ready`.
// Freshness of a check run = its workflow run's created_at (else the run's own completed_at / started_at); of a status = its
// created_at. Freshness that cannot be read counts as fresh (fail fast).
// RESIDUAL (documented, not closed): a draft-era SUCCESS is not second-guessed. A draft-era success of a name whose ready-event
// run is not created yet (seconds after `gh pr ready`) counts as pass. The window is narrow: the skipped job of the same workflow
// keeps the wait open until that workflow's ready run exists, and the live gate re-reads CI before any merge. Requiring a
// ready-era run for every identity would hang on checks whose workflows do not trigger on `ready_for_review`.
import { EXIT } from './cli.mjs';
import { requiredFromRules } from './protection.mjs';

// The bot a status of an app's check comes from. Statuses carry no app id, only creator.login, so a pinned identity accepts a
// status only from its app's known bot (15368 = GitHub Actions; 8329 = Vercel, seen as `vercel[bot]` on EW heads). An app
// not listed here never satisfies a pin by status: the identity stays `missing` (reported, never passed).
export const KNOWN_APP_BOTS = Object.freeze({ 15368: 'github-actions[bot]', 8329: 'vercel[bot]' });

export const MAX_READ_FAILURES = 5;

const GOOD = new Set(['success', 'neutral']);
const BAD = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
// fail > cancelled > pending > missing / stale-skip / stale-fail > fresh-skip > pass: the worst producer decides the identity.
const RANK = { fail: 7, cancelled: 6, pending: 5, missing: 4, 'stale-skip': 4, 'stale-fail': 4, 'fresh-skip': 2, pass: 1 };
const isGood = (s) => s === 'pass' || s === 'fresh-skip';
const isBad = (s) => s === 'fail' || s === 'cancelled';
const isWaiting = (s) => s === 'pending' || s === 'missing' || s === 'stale-skip' || s === 'stale-fail';

const keyOf = (i) => `${i.name}\u0000${i.appId ?? ''}`;
const byIdDesc = (a, b) => Number(b.id) - Number(a.id);

// Latest result per producer: a check run's highest id per (name, app) -- a re-queued run gets a NEW, larger id (verified on
// real EW re-runs: PR 1599 `Typecheck + Vitest`, PR 1617 `Playwright suite`) -- never ordered by started_at, which a queued
// re-run has not got. A status list is reduced to the highest id per context.
function latestRuns(runs, name, appId) {
  const byApp = new Map();
  for (const r of runs) {
    if (r?.name !== name) continue;
    if (appId !== null && r.app?.id !== appId) continue;
    const key = r.app?.id ?? null;
    const have = byApp.get(key);
    if (!have || Number(r.id) > Number(have.id)) byApp.set(key, r);
  }
  return [...byApp.values()].sort(byIdDesc);
}

function latestStatus(statuses, context) {
  let best = null;
  for (const s of statuses) if (s?.context === context && (best === null || Number(s.id) > Number(best.id))) best = s;
  return best;
}

function statusState(s) {
  if (s.state === 'success') return 'pass';
  if (s.state === 'pending') return 'pending';
  return 'fail'; // failure, error, anything GitHub adds later
}

// The identities (name + optional app pin) the two policy sources require, de-duplicated.
function identitiesOf(sources) {
  const seen = new Map();
  for (const src of [sources.classic, sources.rules]) {
    if (src?.kind !== 'present') continue;
    for (const row of src.rows) {
      const id = { name: row.context, appId: row.appId ?? null };
      seen.set(keyOf(id), id);
    }
  }
  return [...seen.values()];
}

export async function waitForCi({ readers, options, clock, onProgress = () => {} }) {
  const { appearTimeoutMs, timeoutMs, intervalMs, waitAll, configChecks = [] } = options;
  const start = clock.now();
  const elapsed = () => clock.now() - start;

  let head = null;
  let last = { identities: [], states: [], readyAt: null };
  const sources = { classic: null, rules: null };
  const suiteCache = new Map();
  let lastSignature = null;
  let readFailures = 0;
  let lastError = null;
  let readyAtMemo;

  const getReadyAt = async (pr) => {
    if (readyAtMemo !== undefined) return readyAtMemo;
    const events = await readers.timeline();
    const ready = events.filter((e) => e?.event === 'ready_for_review' && Number.isFinite(Date.parse(e.created_at)));
    ready.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    readyAtMemo = ready.length > 0 ? ready[0].created_at : pr.createdAt;
    return readyAtMemo;
  };

  // created_at (ms) of the workflow runs of a check run's suite: [] for a non-Actions check run. Cached per suite; an unreadable
  // lookup throws and is not cached, so the next poll asks again.
  const suiteCreated = async (run) => {
    const suite = run.check_suite?.id;
    if (suite === undefined || suite === null) return [];
    let workflowRuns = suiteCache.get(suite);
    if (workflowRuns === undefined) {
      workflowRuns = await readers.suiteRuns(suite);
      suiteCache.set(suite, workflowRuns);
    }
    return workflowRuns.map((w) => Date.parse(w?.created_at)).filter(Number.isFinite);
  };

  // A skipped check run is only "done" when its workflow run was created at or after the ready event; a draft-era skip is not.
  const skipState = async (run, pr) => {
    let created;
    try {
      created = await suiteCreated(run);
    } catch {
      return 'stale-skip'; // unreadable: not proven fresh
    }
    if (created.length === 0) return 'stale-skip'; // a non-Actions skipped check run has no workflow run
    const readyAt = Date.parse(await getReadyAt(pr));
    return Math.max(...created) >= readyAt ? 'fresh-skip' : 'stale-skip';
  };

  // Does a failed / cancelled check run predate the ready event? By its workflow run, else by its own timestamps. Anything
  // unreadable or unknown counts as fresh: a failure is reported rather than waited on.
  const runPredatesReady = async (run, pr) => {
    try {
      const readyAt = Date.parse(await getReadyAt(pr));
      const created = await suiteCreated(run);
      if (created.length > 0) return Math.max(...created) < readyAt;
      const at = Date.parse(run.completed_at ?? run.started_at);
      return Number.isFinite(at) && at < readyAt;
    } catch {
      return false;
    }
  };
  const statusPredatesReady = async (status, pr) => {
    try {
      const at = Date.parse(status.created_at);
      return Number.isFinite(at) && at < Date.parse(await getReadyAt(pr));
    } catch {
      return false;
    }
  };

  const runState = async (run, pr) => {
    if (run.status !== 'completed') return 'pending';
    if (GOOD.has(run.conclusion)) return 'pass';
    if (run.conclusion === 'skipped') return skipState(run, pr);
    // failure, timed_out, ... or a conclusion we do not know (never a pass); a draft-era one is stale and keeps waiting
    const bad = run.conclusion === 'cancelled' ? 'cancelled' : 'fail';
    return (await runPredatesReady(run, pr)) ? 'stale-fail' : bad;
  };

  const evaluate = async (identity, obs, pr) => {
    const producers = [];
    for (const run of latestRuns(obs.checkRuns, identity.name, identity.appId)) {
      producers.push({ state: await runState(run, pr), url: run.html_url ?? null });
    }
    const status = latestStatus(obs.statuses, identity.name);
    if (status) {
      const bot = identity.appId === null ? undefined : KNOWN_APP_BOTS[identity.appId];
      const counts = identity.appId === null || (bot !== undefined && status.creator?.login === bot);
      if (counts) {
        let state = statusState(status);
        if (state === 'fail' && (await statusPredatesReady(status, pr))) state = 'stale-fail';
        producers.push({ state, url: status.target_url ?? null });
      }
    }
    if (producers.length === 0) return { name: identity.name, appId: identity.appId, state: 'missing', url: null };
    const worst = producers.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    return { name: identity.name, appId: identity.appId, state: worst.state, url: worst.url };
  };

  const describe = (states) => states.map((s) => `${s.name}=${s.state}`).join(', ');

  const result = async (exitCode, verdict, extra = {}) => {
    let readyAt = readyAtMemo ?? null;
    if (readyAt === null && last.pr) {
      try { readyAt = await getReadyAt(last.pr); } catch { readyAt = null; }
    }
    return {
      exitCode,
      output: {
        ok: exitCode === EXIT.OK,
        verdict,
        head,
        readyAt,
        requiredSource: { classic: sources.classic?.kind ?? null, rules: sources.rules?.kind ?? null },
        checks: last.states,
        ...extra,
      },
    };
  };

  const poll = async () => {
    readyAtMemo = undefined;
    const pr = await readers.pr();
    last = { ...last, pr };
    if (head === null) {
      head = pr.head;
      if (pr.isDraft) return result(EXIT.USAGE, 'draft', { message: 'the PR is a draft: run `gh pr ready` first' });
    } else {
      if (pr.head !== head) return result(EXIT.FAILED, 'head-moved', { message: `the head moved from ${head} to ${pr.head}`, newHead: pr.head });
      if (pr.isDraft) return result(EXIT.FAILED, 'draft', { message: 'the PR went back to draft' });
    }

    // The required set: two independent policy sources, each read until it answers present or absent.
    if (sources.classic === null || sources.classic.kind === 'unreadable') sources.classic = await readers.classic(pr.base);
    if (sources.rules === null || sources.rules.kind === 'unreadable') {
      try {
        sources.rules = requiredFromRules(await readers.rules(pr.base));
      } catch (err) {
        sources.rules = { kind: 'unreadable', reason: String(err?.message ?? err).split('\n')[0] };
      }
    }
    if (sources.classic.kind === 'absent' && sources.rules.kind === 'absent') {
      return result(EXIT.FAILED, 'no-required-checks', { message: 'neither branch protection nor a ruleset requires any status check on the base branch' });
    }
    const unverified = sources.classic.kind === 'unreadable' || sources.rules.kind === 'unreadable';
    const identities = identitiesOf(sources);

    const obs = { checkRuns: await readers.checkRuns(pr.head), statuses: await readers.statuses(pr.head) };
    const states = [];
    for (const identity of identities) states.push(await evaluate(identity, obs, pr));
    last = { ...last, identities, states };

    // Nothing known to wait for (both sources unreadable, or one unreadable and the other absent): report the config's list.
    const configStates = async () => {
      const out = [];
      for (const name of configChecks) out.push(await evaluate({ name, appId: null }, obs, pr));
      return out;
    };
    const unverifiedResult = async () => {
      const diagnostics = await configStates();
      const reasons = ['classic', 'rules'].filter((k) => sources[k].kind === 'unreadable').map((k) => `${k}: ${sources[k].reason}`);
      return result(EXIT.FAILED, 'unverified', {
        message: `the required checks could not be read from every source (${reasons.join('; ')}), so a green result cannot be trusted; ask the owner`,
        configChecks: diagnostics,
      });
    };
    if (identities.length === 0) return unverifiedResult();

    const bad = states.filter((s) => isBad(s.state));
    const waiting = states.filter((s) => isWaiting(s.state));
    const signature = waiting.map((s) => `${s.name}=${s.state}`).join(', ');
    if (signature !== lastSignature) {
      lastSignature = signature;
      onProgress(waiting.length > 0 ? `waiting for: ${signature}` : 'no check is waiting');
    }

    if (bad.length > 0 && (!waitAll || waiting.length === 0)) {
      return result(EXIT.FAILED, 'failed', { message: `failed: ${bad.map((s) => `${s.name}=${s.state}${s.url ? ` (${s.url})` : ''}`).join('; ')}`, failures: bad });
    }

    if (waiting.length > 0) {
      const absent = waiting.filter((s) => s.state === 'missing' || s.state === 'stale-skip' || s.state === 'stale-fail');
      if (absent.length > 0 && elapsed() >= appearTimeoutMs) {
        const missing = absent.filter((s) => s.state === 'missing');
        const stale = absent.filter((s) => s.state === 'stale-skip');
        const staleFails = absent.filter((s) => s.state === 'stale-fail');
        const skipNote = stale.length ? `only a draft-era skip for: ${stale.map((s) => s.name).join(', ')}` : '';
        if (missing.length > 0) {
          const failNote = staleFails.length ? `a draft-era failure stands for: ${staleFails.map((s) => s.name).join(', ')}` : '';
          const notes = [skipNote, failNote].filter(Boolean);
          return result(EXIT.FAILED, 'missing', { message: `no result appeared for: ${missing.map((s) => s.name).join(', ')}${notes.length ? `; ${notes.join('; ')}` : ''}` });
        }
        if (staleFails.length > 0) {
          // The failure was never replaced by a ready-era result, so it stands (a draft-era skip, if any, is listed with it).
          const listed = staleFails.map((s) => `${s.name}=fail${s.url ? ` (${s.url})` : ''} (result predates ready)`).join('; ');
          return result(EXIT.FAILED, 'failed', { message: `failed: ${listed}${skipNote ? `; ${skipNote}` : ''}`, failures: staleFails });
        }
        return result(EXIT.FAILED, 'stale-skipped', { message: `only a draft-era skipped result exists for: ${stale.map((s) => s.name).join(', ')}: their workflow did not run on the ready event: re-run it or ask the owner` });
      }
      if (elapsed() >= timeoutMs) return result(EXIT.FAILED, 'timeout', { message: `still waiting after ${Math.round(elapsed() / 1000)}s: ${describe(waiting)}` });
      return null;
    }

    // Everything is terminal-good. Re-read the PR once more: the head must not have moved, and it must not be a draft again.
    const again = await readers.pr();
    if (again.head !== head) return result(EXIT.FAILED, 'head-moved', { message: `the head moved from ${head} to ${again.head}`, newHead: again.head });
    if (again.isDraft) return result(EXIT.FAILED, 'draft', { message: 'the PR went back to draft' });
    if (unverified) return unverifiedResult();
    return result(EXIT.OK, 'passed');
  };

  for (;;) {
    let outcome = null;
    try {
      outcome = await poll();
      readFailures = 0;
    } catch (err) {
      lastError = err;
      readFailures += 1;
      if (readFailures >= MAX_READ_FAILURES) {
        return result(EXIT.UNAVAILABLE, 'github', { message: `${readFailures} GitHub reads in a row failed: ${String(lastError?.message ?? lastError).split('\n')[0]}` });
      }
      if (elapsed() >= timeoutMs) return result(EXIT.FAILED, 'timeout', { message: `GitHub reads kept failing until the ${Math.round(timeoutMs / 1000)}s limit` });
    }
    if (outcome) return outcome;
    await clock.sleep(intervalMs);
  }
}
