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
// A needs:-gated aggregate (EW "Typecheck + Vitest") is only created when its shard jobs finish, ~8-12 min after ready, so a
// required identity that is still absent at --appear-timeout does not end the wait while any check run or workflow run of the
// head, created or (re-)started at or after the ready event, is still queued / in progress (reported as `heldBy`); only --timeout bounds that.
// A failure read from a commit status, and an absence verdict past --appear-timeout, are each confirmed by one more read of the
// head's check runs and statuses before they are reported (#159, #168).
// RESIDUAL (documented, not closed): a draft-era SUCCESS is not second-guessed. A draft-era success of a name whose ready-event
// run is not created yet (seconds after `gh pr ready`) counts as pass. The window is narrow: the skipped job of the same workflow
// keeps the wait open until that workflow's ready run exists, and the live gate re-reads CI before any merge. Requiring a
// ready-era run for every identity would hang on checks whose workflows do not trigger on `ready_for_review`.
import { EXIT } from './cli.mjs';
import { readClassicRequired, requiredFromRules } from './protection.mjs';

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
// A workflow run / check run that has not finished (GitHub's statuses: queued, in_progress, waiting, pending, requested).
const ACTIVE_WORKFLOW_RUN = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
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
  let base = null; // the base branch the cached policy sources were read for; a retarget (same head) invalidates them
  let last = { identities: [], states: [], readyAt: null };
  const sources = { classic: null, rules: null };
  const suiteCache = new Map();
  let lastSignature = null;
  let readFailures = 0;
  let lastError = null;
  let readyAtMemo;
  let held = null; // the ready-era run that last kept an absent required check waiting past --appear-timeout
  let heldSignature = null;

  const getReadyAt = async (pr) => {
    if (readyAtMemo !== undefined) return readyAtMemo;
    const events = await readers.timeline();
    const ready = events.filter((e) => e?.event === 'ready_for_review' && Number.isFinite(Date.parse(e.created_at)));
    ready.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    readyAtMemo = ready.length > 0 ? ready[0].created_at : pr.createdAt;
    return readyAtMemo;
  };

  // created_at (ms) of the workflow runs of a check run's suite: [] for a non-Actions check run. Cached per suite; an unreadable
  // lookup throws and is not cached, so the next poll asks again. A re-run keeps its suite but moves the workflow run's
  // run_started_at, and its new check runs have higher ids: seeing an id above the one the entry was read for re-reads the suite
  // (at most once per newer check run, never once per poll), so a re-run is not judged by a stale cached start. The run read can
  // lag a re-run's check runs (a new attempt's check run listed while the workflow run still shows the previous attempt), so the
  // entry also remembers whether its newest check run was still pending when read: that run being seen completed re-reads the
  // suite once more (#176). Each entry is refreshed at most twice per check run id.
  const suiteCreated = async (run) => {
    const suite = run.check_suite?.id;
    if (suite === undefined || suite === null) return [];
    let entry = suiteCache.get(suite);
    const id = Number(run.id);
    if (entry === undefined || id > entry.maxId || (id === entry.maxId && entry.pending && run.status === 'completed')) {
      const workflowRuns = await readers.suiteRuns(suite);
      const maxId = Math.max(id, entry?.maxId ?? -Infinity);
      entry = { workflowRuns, maxId, pending: id === maxId && run.status !== 'completed' };
      suiteCache.set(suite, entry);
    }
    const workflowRuns = entry.workflowRuns;
    return workflowRuns.map((w) => Date.parse(w?.created_at)).filter(Number.isFinite);
  };
  // Like suiteCreated, but a re-run keeps its run id and created_at and only moves run_started_at: both instants of each workflow
  // run are returned (the caller takes the maximum). Used to decide whether a run is still of the ready era (findHolder).
  // A RESULT is dated by suiteStarted (a failure) or suiteCreated (a skip), see below.
  const suiteActive = async (run) => {
    const suite = run.check_suite?.id;
    if (suite === undefined || suite === null) return [];
    await suiteCreated(run); // fills the cache
    return suiteCache.get(suite).workflowRuns.flatMap((w) => [Date.parse(w?.created_at), Date.parse(w?.run_started_at)]).filter(Number.isFinite);
  };

  // run_started_at (ms) of the workflow runs of a check run's suite, else created_at when a run has none: when this attempt of the
  // run began, with its run_attempt. A re-run keeps created_at and moves run_started_at, so this is what dates a re-run's FAILURE.
  const suiteStarted = async (run) => {
    const suite = run.check_suite?.id;
    if (suite === undefined || suite === null) return [];
    await suiteCreated(run); // fills the cache
    return suiteCache.get(suite).workflowRuns
      .map((w) => { const s = Date.parse(w?.run_started_at); return { at: Number.isFinite(s) ? s : Date.parse(w?.created_at), attempt: Number(w?.run_attempt) }; })
      .filter((d) => Number.isFinite(d.at));
  };

  // A skipped check run is only "done" when its workflow run was created at or after the ready event; a draft-era skip is not.
  // This stays on created_at, not run_started_at, on purpose (the asymmetry with a failure, see runPredatesReady): a re-run replays
  // the original run's (draft-era) event payload, so it skips again however late it starts, and a skip stays stale until a run
  // that was created after the ready event replaces it.
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

  // Does a failed / cancelled check run predate the ready event? By its workflow run's start (run_started_at, which a re-run moves;
  // else created_at), else by its own timestamps. A re-run started after ready that then failed is a fresh, real failure of the
  // ready-era code, unlike a re-run's skip (see skipState). The check runs are read before the workflow runs, so a re-run that began
  // in between moves run_started_at under a failure that belongs to the PREVIOUS attempt (#174): when the dating run is attempt 2
  // or later and the check run's own completed/started time is readable and earlier than that start, the failure is dated by its
  // own time (an old draft-era failure stays stale; a ready-era one still ends the wait). Anything else unreadable or unknown
  // counts as fresh: a failure is reported rather than waited on.
  const runPredatesReady = async (run, pr) => {
    try {
      const readyAt = Date.parse(await getReadyAt(pr));
      const started = await suiteStarted(run);
      if (started.length > 0) {
        const latest = started.reduce((a, b) => (b.at > a.at ? b : a));
        let at = latest.at;
        const own = Date.parse(run.completed_at ?? run.started_at);
        if (latest.attempt > 1 && Number.isFinite(own) && own < at) at = own; // the failure is of an earlier attempt
        return at < readyAt;
      }
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

  const statusBasis = new WeakMap(); // evaluate() result -> the commit status it rests on (for the status re-read and its evidence)
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
        producers.push({ state, url: status.target_url ?? null, status });
      }
    }
    if (producers.length === 0) return { name: identity.name, appId: identity.appId, state: 'missing', url: null };
    const worst = producers.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    const out = { name: identity.name, appId: identity.appId, state: worst.state, url: worst.url };
    if (worst.status) statusBasis.set(out, worst.status);
    return out;
  };

  // The first check run or workflow run of the head that was created or (re-)started at or after the ready event and has not
  // finished, else null. A check run is dated by its workflow run (else its own started_at); a workflow run by its created_at or,
  // for a re-run, its run_started_at; a run whose age cannot be read does not hold the wait.
  const findHolder = async (obs, pr) => {
    const readyAt = Date.parse(await getReadyAt(pr));
    for (const run of obs.checkRuns) {
      if (!run || run.status === 'completed') continue;
      const active = await suiteActive(run);
      const at = active.length > 0 ? Math.max(...active) : Date.parse(run.started_at);
      if (Number.isFinite(at) && at >= readyAt) return { kind: 'check-run', id: run.id ?? null, name: run.name ?? null, status: run.status ?? null, createdAt: Number.isFinite(at) ? new Date(at).toISOString().replace('.000Z', 'Z') : null, url: run.html_url ?? null };
    }
    if (readers.headRuns) {
      for (const w of await readers.headRuns(pr.head)) {
        if (!w || !ACTIVE_WORKFLOW_RUN.has(w.status)) continue;
        const created = Date.parse(w.created_at);
        const restarted = Date.parse(w.run_started_at);
        const when = Number.isFinite(created) && created >= readyAt ? w.created_at : Number.isFinite(restarted) && restarted >= readyAt ? w.run_started_at : null;
        if (when !== null) return { kind: 'workflow-run', id: w.id ?? null, name: w.name ?? null, status: w.status, createdAt: when, url: w.html_url ?? null };
      }
    }
    return null;
  };

  const statusEvidenceOf = (failures) => failures.map((f) => statusBasis.get(f)).filter(Boolean).map((x) => ({ context: x.context, id: x.id ?? null, state: x.state, createdAt: x.created_at ?? null }));

  const describe = (states) => states.map((s) => `${s.name}=${s.state}`).join(', ');

  const result = async (exitCode, verdict, extra = {}) => {
    let readyAt = readyAtMemo ?? null;
    if (held !== null) extra = { heldBy: held, ...extra };
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

  const baseChanged = (now) => result(EXIT.FAILED, 'base-changed', { message: `the base branch changed from ${base} to ${now}: the required checks are those of the new base, so the wait must restart`, newBase: now ?? null });

  const poll = async () => {
    readyAtMemo = undefined;
    const pr = await readers.pr();
    last = { ...last, pr };
    if (head === null) {
      head = pr.head;
      base = pr.base ?? null;
      if (pr.isDraft) return result(EXIT.USAGE, 'draft', { message: 'the PR is a draft: run `gh pr ready` first' });
    } else {
      if (pr.head !== head) return result(EXIT.FAILED, 'head-moved', { message: `the head moved from ${head} to ${pr.head}`, newHead: pr.head });
      if (pr.isDraft) return result(EXIT.FAILED, 'draft', { message: 'the PR went back to draft' });
      if ((pr.base ?? null) !== base) return baseChanged(pr.base);
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

    // Everything from the evaluation to the verdict. `confirmed` is true on the second pass, which a failure read from a commit
    // status, or an absence verdict past --appear-timeout, triggers: the head's check runs and statuses are read again first, so a
    // failure a newer status already replaced, or an aggregate that appeared after the snapshot, is not reported. Never a third pass.
    const reread = async () => ({ checkRuns: await readers.checkRuns(pr.head), statuses: await readers.statuses(pr.head) });
    const decide = async (obs, confirmed) => {
    const states = [];
    for (const identity of identities) states.push(await evaluate(identity, obs, pr));
    last = { ...last, identities, states };
    const confirmStatusFailures = async (failures) => (confirmed || !failures.some((f) => statusBasis.has(f)) ? undefined : decide(await reread(), true));
    const failedResult = (message, failures) => {
      const statusEvidence = statusEvidenceOf(failures);
      return result(EXIT.FAILED, 'failed', { message, failures, ...(statusEvidence.length > 0 ? { statusEvidence } : {}) });
    };

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
      const rechecked = await confirmStatusFailures(bad);
      if (rechecked !== undefined) return rechecked;
      return failedResult(`failed: ${bad.map((s) => `${s.name}=${s.state}${s.url ? ` (${s.url})` : ''}`).join('; ')}`, bad);
    }

    if (waiting.length > 0) {
      const absent = waiting.filter((s) => s.state === 'missing' || s.state === 'stale-skip' || s.state === 'stale-fail');
      // Past --appear-timeout an absent identity is final only if nothing of the ready era is still running on the head: a
      // needs:-gated aggregate is created late by design (#159). Until --timeout the wait goes on, naming what holds it.
      const holder = absent.length > 0 && elapsed() >= appearTimeoutMs ? await findHolder(obs, pr) : null;
      if (holder !== null) {
        held = holder;
        const note = `still running past the appear window: ${holder.kind} ${holder.name ?? holder.id} (${holder.status})`;
        if (note !== heldSignature) {
          heldSignature = note;
          onProgress(note);
        }
      }
      if (absent.length > 0 && elapsed() >= appearTimeoutMs && holder === null) {
        // The snapshot was taken before findHolder read the workflow runs: an aggregate created and finished in between (or a lagging
        // check-runs read) would otherwise be reported absent. Look once more before the terminal verdict.
        if (!confirmed) return decide(await reread(), true);
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
          const rechecked = await confirmStatusFailures(staleFails);
          if (rechecked !== undefined) return rechecked;
          return failedResult(`failed: ${listed}${skipNote ? `; ${skipNote}` : ''}`, staleFails);
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
    if ((again.base ?? null) !== base) return baseChanged(again.base);
    if (unverified) return unverifiedResult();
    return result(EXIT.OK, 'passed');
    };
    return decide({ checkRuns: await readers.checkRuns(pr.head), statuses: await readers.statuses(pr.head) }, false);
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

export const DEFAULT_APPEAR_SECONDS = 300;
export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 15;

// The GitHub reads waitForCi polls, for PR `pr` (shared by `pipeline ci-wait` and the merge-carry loop of `P merge --owner-go`).
export function ciReaders(gh, pr) {
  return {
    async pr() {
      const v = gh.prView(pr, ['headRefOid', 'isDraft', 'createdAt', 'baseRefName']);
      return { head: v.headRefOid, isDraft: v.isDraft === true, createdAt: v.createdAt, base: v.baseRefName };
    },
    classic: async (base) => readClassicRequired(gh, base),
    rules: async (base) => gh.branchRules(base),
    checkRuns: async (head) => gh.checkRunsOf(head),
    statuses: async (head) => gh.statusesOf(head),
    timeline: async () => gh.timelineOf(pr),
    suiteRuns: async (suiteId) => gh.workflowRunsOfSuite(suiteId),
    headRuns: async (head) => gh.workflowRunsOfHead(head), // no fallback: a gh without it must fail the read, not silently end the late-aggregate hold
  };
}

// Test hook for the merge-carry loop: PIPELINE_CI_APPEAR_MS / PIPELINE_CI_TIMEOUT_MS / PIPELINE_CI_INTERVAL_MS can only SHORTEN the defaults
// (a shorter wait ends in a "missing" / "timeout" verdict, the safe direction), never stretch them.
export function ciWaitTiming(env = {}) {
  const cap = (name, limit) => {
    const v = Number(env?.[name]);
    return Number.isInteger(v) && v >= 0 ? Math.min(v, limit) : limit;
  };
  return {
    appearTimeoutMs: cap('PIPELINE_CI_APPEAR_MS', DEFAULT_APPEAR_SECONDS * 1000),
    timeoutMs: cap('PIPELINE_CI_TIMEOUT_MS', DEFAULT_TIMEOUT_SECONDS * 1000),
    intervalMs: cap('PIPELINE_CI_INTERVAL_MS', DEFAULT_INTERVAL_SECONDS * 1000),
  };
}
