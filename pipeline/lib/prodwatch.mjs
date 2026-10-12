// After an agent's PR merges, prove the PRODUCTION deployment of that merge is live and healthy, and undo it safely if
// not. Safe means: roll back only when the deployment that is failing is still the one serving production (a newer,
// healthy deploy by someone else must never be removed), re-read what is live immediately before acting, verify the
// rollback actually landed and production passes smoke again, and say so loudly in an issue. Every external effect
// (GitHub, Vercel, git, the smoke command, the clock, the lock) is injected, so each branch is unit-testable and the
// command wires the real ones. Fail closed: anything unclear ends in an outcome that asks a human, never a guess.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fill } from './config.mjs';
import { git as gitRun, NETWORK_TIMEOUT_MS } from './git.mjs';
import { runShellAsync } from './proc.mjs';
import { resolvedRollbacks, unresolvedRollbacks } from './run-events.mjs';
import { OUTCOME_NEXT, OUTCOME_STEP, applyCheckpoint, bindRecord, emptyRecord } from './run-record.mjs';
import { readSummaryComment, writeSummaryComment } from './summary-comment.mjs';
import { tail } from './vercel.mjs';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const RETRY_WAIT_MS = 60_000; // CDN propagation: one retry after this, and the pause between "is it live yet" looks
export const NOT_LIVE_CHECKS = 5;
const SMOKE_TIMEOUT_MS = 5 * 60_000;
const SCAN_LIMIT = 10;
const REVERT_BRANCH = /^agent\/revert-[A-Za-z0-9._-]+$/;

// A pause label (pipeline-rollback) stops further agent merges; only outcomes where production state is uncertain or was
// changed by us carry it. The other outcomes need a human to look, but do not freeze the pipeline.
const PAUSING = new Set(['recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped']);
const URGENT = new Set(['rollback-failed', 'changed-during-recovery', 'rollback-skipped']);

export function exitCodeFor(outcome) {
  if (outcome === 'merged') return 0;
  if (outcome === 'deploy-not-observed') return 3;
  return 1;
}

// The merge commit of a MERGED PR, for when `merge` could not name it (mergeSha:null). Reads the PR up to `looks` times, `pauseMs`
// apart: {state:'merged', sha} | {state:'not-merged', prState} (OPEN/CLOSED: nothing to watch) | {state:'unresolved'} (MERGED but
// GitHub never named the commit, or could not be read).
export async function resolveMergeSha({ prView, looks = 6, pauseMs = 5000, sleep = defaultSleep }) {
  let prState = null;
  for (let i = 0; i < looks; i++) {
    if (i > 0) await sleep(pauseMs);
    try {
      const view = await prView(['state', 'mergeCommit']);
      prState = view?.state ?? null;
      const oid = typeof view?.mergeCommit?.oid === 'string' ? view.mergeCommit.oid.toLowerCase() : '';
      if (prState === 'MERGED' && /^[0-9a-f]{40}$/.test(oid)) return { state: 'merged', sha: oid };
      if (prState === 'OPEN' || prState === 'CLOSED') return { state: 'not-merged', prState };
    } catch { /* a flaky read counts as another miss */ }
  }
  return { state: 'unresolved', prState };
}

// "https://App.example.com/x" and "app.example.com" are the same host; anything unparseable is compared as-is.
export function hostOf(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

const created = (d) => Date.parse(d.created_at ?? '') || 0;
const newestFirst = (list) => [...list].sort((a, b) => created(b) - created(a) || Number(b.id) - Number(a.id));
const urlOf = (s) => s?.environment_url || s?.target_url || null;

// Which commit produced the deployment served at `host`? GitHub deployments are the only place a sha is recorded (Vercel
// inspect has none). Best effort: null when nothing matches or GitHub cannot be read.
async function shaForHost(github, environment, host) {
  if (!host) return null;
  try {
    const recent = newestFirst((await github.deployments({ environment })) ?? []).slice(0, SCAN_LIMIT);
    for (const d of recent) {
      const statuses = (await github.deploymentStatuses(d.id)) ?? [];
      if (statuses.some((s) => s.state === 'success' && hostOf(urlOf(s)) === host)) return d.sha ?? null;
    }
  } catch {
    /* unknown: the caller treats the deployment as "not ours" */
  }
  return null;
}

// The record `merge` writes before merging: the deployment production served at that moment, our rollback target.
export function readKnownGood(root) {
  const file = join(root, '.review', 'prod-before.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'no .review/prod-before.json: `merge` records the known-good deployment before merging' : `cannot read ${file}: ${err.message}` };
  }
  return knownGoodFrom(raw, '.review/prod-before.json');
}

// {ok, id, url, sha} from a recorded deployment ({id, url, sha}); `source` names where it came from, for the refusal text.
function knownGoodFrom(raw, source) {
  const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
  const id = typeof raw?.id === 'string' || typeof raw?.id === 'number' ? String(raw.id) : '';
  const target = url || id;
  if (!target) return { ok: false, reason: `${source} has neither a url nor an id to roll back to` };
  if (!/^[^\s-]\S*$/.test(target)) return { ok: false, reason: `${source} holds an unusable rollback target: ${JSON.stringify(target)}` };
  return { ok: true, id, url, sha: typeof raw.sha === 'string' ? raw.sha : null };
}

// The known-good deployment from the NEWEST `prod-before` event (the same record `merge` also writes to
// .review/prod-before.json, kept on the PR so a session without that file still has the rollback target). `events` is
// listEvents() output. An event for another environment is ignored; one whose payload cannot be read is skipped.
export function knownGoodFromEvents(events, environment) {
  const candidates = (events ?? []).filter((e) => e?.kind === 'prod-before' && e.dataStatus === 'ok' && (!e.data?.environment || !environment || e.data.environment === environment));
  const latest = candidates.at(-1);
  if (!latest) return { ok: false, reason: 'no .review/prod-before.json and no prod-before event on the PR: `merge` records the known-good deployment before merging' };
  return knownGoodFrom(latest.data?.deployment, `the prod-before event ${latest.id}`);
}

// The production smoke: the project's configured command with {url} (strict: a missing value is an error, never a
// half-filled command), expect-text passed through the environment. Never rejects; a timeout is a failed smoke.
export function createSmoke({ production, cwd, env, runShell = runShellAsync }) {
  return async ({ url, expectText }) => {
    const command = fill(production.smoke, { url }, { strict: true });
    // '' (not undefined) so an expect-text exported in the caller's own environment cannot leak into this run.
    const r = await runShell(command, { cwd, env: { ...env, PIPELINE_SMOKE_EXPECT_TEXT: expectText ?? '' }, timeoutMs: SMOKE_TIMEOUT_MS });
    return { ok: r.code === 0 && !r.timedOut, code: r.code, tail: tail(`${r.stdout}\n${r.stderr}`, 3000) };
  };
}

// Real git for the revert PR. The revert is made in a throwaway worktree on a new branch from origin/<base>, so the
// caller's checkout, index and branch are never touched, and the worktree is removed whatever happens.
export function createGitOps({ root, gitFn = gitRun, remote = 'origin' } = {}) {
  return {
    async revertBranch({ sha, branch, base, worktreeDir, dirName }) {
      // Never push anywhere but a fresh agent/revert-* branch: the default branch is not ours to write.
      if (!REVERT_BRANCH.test(branch) || branch === base) throw new Error(`refusing to push revert to ${JSON.stringify(branch)}`);
      const g = (args, cwd = root, timeoutMs) => gitFn(args, { cwd, ...(timeoutMs ? { timeoutMs } : {}) });
      // fetch and push run inside the production lock: a hung network call must time out, not hold it forever.
      g(['fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`], root, NETWORK_TIMEOUT_MS);
      const dir = join(worktreeDir, dirName);
      g(['worktree', 'add', '--no-track', '-b', branch, dir, `${remote}/${base}`]);
      try {
        const subject = g(['log', '-1', '--format=%s', sha], dir).trim();
        // A squash merge has one parent; a true merge commit needs -m 1 (keep the first parent, i.e. the base side).
        const parents = g(['rev-list', '--parents', '-n', '1', sha], dir).trim().split(/\s+/).length - 1;
        try {
          g(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha], dir);
        } catch (err) {
          try { g(['revert', '--abort'], dir); } catch { /* nothing in progress */ }
          throw err;
        }
        g(['push', '-u', remote, `HEAD:refs/heads/${branch}`], dir, NETWORK_TIMEOUT_MS);
        return { branch, subject };
      } finally {
        try { g(['worktree', 'remove', '--force', dir]); } catch { /* best effort: a leftover temp worktree is harmless */ }
      }
    },
  };
}

// Shows a running watch in the PR's run record (`inFlight` + step prod-watch) and takes it out again. Display only: every
// call re-reads the summary comment, so it never overwrites what another writer put there since, and it throws on a
// problem (the watch turns that into a warning, never a failure). `gh` = createGitHub().
export function createRunRecordTracker({ gh, pr, host, now = Date.now }) {
  const load = () => {
    const existing = readSummaryComment(gh, pr);
    if (existing.status === 'ok') {
      const mismatch = bindRecord(existing.record, { repo: gh.repo().slug, pr });
      if (mismatch.length) throw new Error(`the run record does not belong to this PR (${mismatch.join('; ')})`);
      return { existing, record: existing.record };
    }
    if (existing.status === 'unsupported' || existing.status === 'invalid') {
      throw new Error(`the run record in the summary comment is ${existing.status}: left alone`);
    }
    const view = gh.prView(pr, ['headRefName', 'baseRefName']);
    return { existing, record: emptyRecord({ repo: gh.repo().slug, pr, branch: view?.headRefName, baseRef: view?.baseRefName }) };
  };
  const apply = (patch) => {
    const { existing, record } = load();
    writeSummaryComment(gh, pr, { record: applyCheckpoint(record, patch, { host, now: now() }), existing });
  };
  return {
    set: (inFlight) => apply({ step: 'prod-watch', inFlight }),
    clear: () => apply({ inFlight: null }),
    // A resumed observe-only watch is the last thing that happens to a stranded run: record how it ended so resume and
    // the inbox stop routing here. A record that already has an outcome (a run that ended on its own) is not overwritten.
    // Summary sections are kept (record-only write); events are not touched, so an open rollback-intent stays open.
    finish: (outcome, detail = '') => {
      const { record } = load();
      if (record.outcome != null || !(outcome in OUTCOME_STEP)) return false;
      apply({ step: OUTCOME_STEP[outcome], outcome, next: OUTCOME_NEXT[outcome], detail: String(detail ?? ''), inFlight: null });
      return true;
    },
  };
}

// ---- issue and PR text ---------------------------------------------------------------------------------------------

const fence = (text) => {
  const body = String(text ?? '').trim() || '(no output)';
  const ticks = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${body}\n${ticks}`;
};
const describe = (d) => (d ? `${d.url ?? 'unknown url'} (id ${d.id ?? 'unknown'})` : 'unknown');

export const issueTitle = (outcome, { pr, sha }) => `[pipeline] production ${outcome} after ${pr ? `#${pr} ` : ''}(${sha.slice(0, 7)})`;

const HEADLINE = {
  'deploy-failed': 'The Production deployment of this merge FAILED. Production was never switched to it, so the previous deployment is still serving; nothing was rolled back.',
  'deploy-not-observed': 'No successful Production deployment of this merge was reported in time. It is unknown whether it is live; nothing was rolled back.',
  'not-live': 'Production kept serving an OLDER deployment than this merge (the smoke passed against it, or it is the known-good deployment), so the merge never went live. Nothing was rolled back.',
  superseded: 'This merge\'s deployment failed the production smoke, but a DIFFERENT deployment is now live and passes it. Nothing was rolled back (that would have removed someone else\'s healthy deploy).',
  recovered: 'The production smoke FAILED after this merge. Production was rolled back to the last known-good deployment and passes the smoke again.',
  'rollback-failed': 'The production smoke FAILED after this merge and the automatic rollback did NOT restore a healthy production.',
  'changed-during-recovery': 'The production smoke FAILED after this merge, but the live deployment changed while recovery was running, so nothing was rolled back (a rollback could have removed someone else\'s deploy).',
  'rollback-skipped': 'The production smoke FAILED after this merge and no automatic rollback was attempted.',
};

const NEXT_STEPS = {
  'deploy-failed': ['Open the failed deployment (link above) and read its build log.', 'Fix forward on a new PR, or revert the merge.', 'Close this issue when production serves what you expect.'],
  'deploy-not-observed': ['Check the Vercel dashboard / GitHub deployments for this commit.', 'If it deployed, run the production smoke by hand; if it did not, redeploy.', 'Close this issue when production is verified.'],
  'not-live': ['Check which deployment the production domain serves (`vercel inspect <domain>`) and whether a newer deploy or a manual rollback pinned it.', 'Promote the merge\'s deployment if it should be live (`vercel promote <url>`).', 'Close this issue when production serves what you expect.'],
  superseded: ['Confirm the live deployment contains the fix you expect; this merge\'s deployment is no longer serving.', 'Fix forward or revert this merge so main does not carry a failing change.', 'Close this issue when done.'],
  recovered: ['Review the revert PR (needs-human) and merge it, or fix forward.', 'This issue carries `pipeline-rollback`, which PAUSES further agent merges: close it once production and main are in the state you want.'],
  'rollback-failed': ['Production may be unhealthy RIGHT NOW: check it and the Vercel dashboard immediately.', 'Roll back or promote a known-good deployment by hand (`vercel rollback <url>`).', 'This issue carries `pipeline-rollback`, which PAUSES further agent merges: close it only when production is healthy.'],
  'changed-during-recovery': ['Check which deployment is live now and whether it is healthy (run the production smoke).', 'Roll back by hand only if the live deployment is the broken one.', 'This issue carries `pipeline-rollback`, which PAUSES further agent merges: close it when production is verified.'],
  'rollback-skipped': ['Production may be unhealthy: check it now.', 'Roll back by hand to the last known-good deployment if needed.', 'This issue carries `pipeline-rollback`, which PAUSES further agent merges: close it when production is verified.'],
};

const VERCEL_NOTE = 'After a rollback Vercel stops auto-assigning production domains to new deployments until one is promoted. A later merge will build but will NOT go live by itself: promote the fixed deployment (`vercel promote <url>` or the dashboard) to resume.';

function issueBody(outcome, ev, prod) {
  const L = [];
  if (URGENT.has(outcome)) L.push('**URGENT: production may be unhealthy and needs a human now.**', '');
  L.push(HEADLINE[outcome] ?? `Outcome: ${outcome}`, '');
  if (ev.reason) L.push(`Reason: ${ev.reason}`, '');
  L.push('## Merge', `- Merge commit: \`${ev.sha}\``, `- Pull request: ${ev.pr ? `#${ev.pr}` : 'not given'}`, `- Watched at: ${ev.startedAt}`, '');
  L.push('## Deployment of this merge', `- ${describe(ev.deployment)}`, `- State: ${ev.deployment?.state ?? 'not observed'}`, '');
  L.push('## Production smoke');
  if (!ev.smoke) L.push('Not run.');
  if (ev.smokeFailure) L.push('First failing run:', fence(ev.smokeFailure.tail));
  if (ev.smoke && ev.smoke !== ev.smokeFailure && !(!ev.smoke.ok && ev.smoke.tail === ev.smokeFailure?.tail)) {
    L.push(`Most recent run (${ev.smoke.ok ? 'passed' : 'failed'}):`, fence(ev.smoke.tail));
  }
  L.push('');
  if (ev.liveBefore || ev.liveAfter) {
    L.push('## Live deployment');
    L.push(`- Before: ${describe(ev.liveBefore)}${ev.liveBeforeSha ? `, commit ${ev.liveBeforeSha.slice(0, 7)}` : ''}`);
    if (ev.liveChanged) L.push(`- Seen again just before rollback: ${describe(ev.liveChanged)}`);
    if (ev.rollback) L.push(`- After rollback: ${describe(ev.liveAfter)}`);
    L.push('');
  }
  if (ev.knownGood) {
    L.push('## Known-good target', `- ${ev.knownGood.url || ev.knownGood.id}${ev.knownGood.sha ? ` (commit ${ev.knownGood.sha.slice(0, 7)})` : ''}`, '');
  }
  if (ev.rollback) {
    L.push('## Rollback', `Command ${ev.rollback.ok ? 'succeeded' : `FAILED (exit ${ev.rollback.code})`}; output:`, fence(ev.rollback.tail), '');
  }
  if (ev.rollback?.ok) {
    L.push('## Vercel does not auto-assign production now', VERCEL_NOTE);
    if (prod?.rollback?.notes) L.push('', `Project note: ${prod.rollback.notes}`);
    L.push('');
  }
  if (ev.notes.length) L.push('## Notes', ...ev.notes.map((n) => `- ${n}`), '');
  L.push('## Next steps', ...(NEXT_STEPS[outcome] ?? ['Investigate.']).map((s, i) => `${i + 1}. ${s}`), '', '_Opened by claude-pipeline `prod-watch`._');
  return L.join('\n');
}

function revertBody(ev, issue, subject) {
  const kg = ev.knownGood?.url || ev.knownGood?.id;
  return [
    `Reverts \`${ev.sha.slice(0, 7)}\`${ev.pr ? ` (#${ev.pr})` : ''}${subject ? `: ${subject}` : ''}.`,
    '',
    `Why: the production smoke failed after this change merged. Production was rolled back to the last known-good deployment${kg ? ` (${kg})` : ''} and passes the smoke again.${issue ? ` Evidence and next steps: ${issue.url ?? `#${issue.number}`}.` : ''}`,
    '',
    'This keeps the default branch in line with what production is serving, so the broken change does not ship again with the next merge. Merge it, or close it and fix forward.',
    '',
    `${VERCEL_NOTE}`,
    '',
    '_Opened by claude-pipeline `prod-watch`; needs a human._',
  ].join('\n');
}

// ---- the watch ------------------------------------------------------------------------------------------------------

/**
 * opts: { config (validated; config.production required), sha, pr?, expectText?, root, retryWaitMs?, notLiveChecks? }
 * deps: findDeployment({sha, environment, timeoutMs}) -> {state: success|failure|timeout, id, url, createdAt}
 *       smoke({url, expectText}) -> {ok, tail}          inspectAlias(domain) -> {id, url, createdAt}  (throws when unknown)
 *       rollback(target) -> {ok, code, tail}            github: {issueCreate, issueComment?, prCreate, prView?, deployments, deploymentStatuses}
 *       git: {revertBranch}    lock(name, fn)    sleep(ms)    now()    note(msg)    readKnownGood()
 * Optional deps (the command wires them when it knows the PR):
 *       events: {post(kind, id, sentence, data), list()}   append-only run events on the PR (see run-events.mjs)
 *       runRecord: {set(inFlight), clear()}                shows the watch in the PR's run record
 * opts.observeOnly: the same smokes and outcome detection, but NEVER a rollback, an issue, a revert PR, a pause label or an
 * event: what would have rolled back is outcome `needs-owner` with the evidence, and a rollback-intent with no
 * rollback-result on the PR is reported as `rollbackInterrupted`.
 * Returns { ok, outcome, mergeSha, deployment, live, issue, revertPr, smoke:{ok, tail}, ... }; exitCodeFor(outcome) is the exit code.
 */
export async function runProdWatch(opts, deps) {
  const warnings = [];
  const { runRecord } = deps;
  const guardRecord = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      warnings.push(`run record: could not ${what}: ${err?.message ?? err}`);
    }
  };
  if (runRecord) {
    const maxMinutes = opts.config.production.deploy_timeout_minutes + 30;
    const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
    await guardRecord('mark the watch in flight', () => runRecord.set({ kind: 'prod-watch', host: opts.host ?? '', startedAt, maxMinutes }));
  }
  let out;
  try {
    out = await watch(opts, deps);
  } finally {
    // Every exit path, a thrown error included, takes the watch out of the record.
    if (runRecord) await guardRecord('clear the in-flight marker', () => runRecord.clear());
  }
  // Observe-only closes the run record itself (nothing else will: the skill's observe-prod route ends here). It never
  // rolls back, so it posts no event; `deploy-not-observed` learned nothing, so the run stays open to watch again.
  if (opts.observeOnly === true && runRecord?.finish && out.outcome !== 'deploy-not-observed') {
    await guardRecord('record the observed outcome', () => runRecord.finish(out.outcome, out.reason ?? ''));
  }
  if (opts.observeOnly === true && deps.events) {
    try {
      const interrupted = await findInterruptedRollback(opts, deps, out);
      if (interrupted) out.rollbackInterrupted = interrupted;
    } catch (err) {
      warnings.push(`could not check the PR for an interrupted rollback: ${err?.message ?? err}`);
    }
  }
  if (warnings.length) out.warnings = [...(out.warnings ?? []), ...warnings];
  return out;
}

// A `rollback-intent` for this merge with no `rollback-result` of the same id: a rollback began and nobody wrote down how
// it ended. -> {intent: {id, url, ...event data}, liveNow: {id, url} | null} | null. The live deployment is what the
// watch just read, or one more read of the domain; null when it cannot be read.
async function findInterruptedRollback(opts, deps, out) {
  const open = unresolvedRollbacks(await deps.events.list(), { mergeSha: opts.sha }).at(-1);
  if (!open) return null;
  let live = out.live ?? null;
  if (!live) {
    try { live = await deps.inspectAlias(hostOf(opts.config.production.url)); } catch { /* reported as unknown */ }
  }
  return {
    intent: { ...(open.dataStatus === 'ok' ? open.data : { unreadable: true }), id: open.id, url: open.url ?? null },
    liveNow: live ? { id: live.id ?? null, url: live.url ?? null } : null,
  };
}

async function watch(opts, deps) {
  const { config, sha, pr = null, expectText = null, root } = opts;
  const observe = opts.observeOnly === true;
  const events = deps.events ?? null;
  const prod = config.production;
  const retryWaitMs = opts.retryWaitMs ?? RETRY_WAIT_MS;
  const notLiveChecks = opts.notLiveChecks ?? NOT_LIVE_CHECKS;
  const { findDeployment, smoke, inspectAlias, rollback, github, git, lock } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const note = deps.note ?? (() => {});
  const readKnown = deps.readKnownGood ?? (() => readKnownGood(root));
  const domain = hostOf(prod.url);
  // provider "other" has no Vercel to ask: we can judge the smoke, but cannot prove what is live or roll back safely.
  const managed = prod.provider !== 'other';

  const ev = {
    sha, pr, startedAt: new Date(now()).toISOString(), deployment: null, smoke: null, smokeFailure: null, live: null, liveBefore: null,
    liveBeforeSha: null, liveChanged: null, liveAfter: null, knownGood: null, rollback: null, reason: null, notes: [],
    warnings: [], issue: null, issueError: null, revertPr: null, revertPrError: null, underlying: null,
  };
  let rollbackTried = false;
  let eventId = null; // `<sha7>-<n>`: shared by this merge's rollback-intent, rollback-result and recovery-reported
  let resultPosted = false;

  // `expect` defaults to the new build's text. A deployment that is NOT this merge's (the rolled-back one, a newer one)
  // cannot contain that text, so those smokes pass null and only judge health.
  const smokeOnce = async (expect = expectText) => {
    let r;
    try {
      r = await smoke({ url: prod.url, expectText: expect });
    } catch (err) {
      r = { ok: false, tail: `smoke could not run: ${err?.message ?? err}` };
    }
    ev.smoke = { ok: r?.ok === true, code: r?.code ?? null, tail: String(r?.tail ?? '') };
    // Keep the FIRST failure: later runs (after a rollback) can pass and would otherwise erase the evidence.
    if (!ev.smoke.ok && !ev.smokeFailure) ev.smokeFailure = ev.smoke;
    return ev.smoke;
  };
  // A fresh deploy can need a minute to reach every edge, so one failure alone proves nothing.
  const smokeWithRetry = async (expect = expectText) => {
    const first = await smokeOnce(expect);
    if (first.ok) return first;
    note(`production smoke failed; retrying in ${Math.round(retryWaitMs / 1000)}s`);
    await sleep(retryWaitMs);
    return smokeOnce(expect);
  };

  // Is the deployment `live` ours (same host, or built from our commit), newer than ours, or older/unknown?
  const relate = async (live) => {
    if (live.url && hostOf(live.url) === hostOf(ev.deployment?.url)) return 'ours';
    const liveSha = await shaForHost(github, prod.environment, hostOf(live.url));
    ev.liveBeforeSha = liveSha;
    if (liveSha && liveSha === sha) return 'ours';
    const theirs = Number(live.createdAt);
    const ours = Date.parse(ev.deployment?.createdAt ?? '');
    return Number.isFinite(theirs) && Number.isFinite(ours) && theirs > ours ? 'newer' : 'older';
  };

  const skip = (reason, outcome = 'rollback-skipped') => {
    ev.reason = reason;
    return outcome;
  };

  async function report(outcome) {
    if (observe || outcome === 'merged') return; // observe-only never opens an issue or a revert PR, nor adds a pause label
    const labels = [PAUSING.has(outcome) ? 'pipeline-rollback' : 'needs-human'];
    try {
      ev.issue = await github.issueCreate({ title: issueTitle(outcome, { pr, sha }), body: issueBody(outcome, ev, prod), labels });
    } catch (err) {
      ev.issueError = String(err?.message ?? err);
    }
    if (outcome !== 'recovered') return;
    const comment = async (body) => {
      if (!ev.issue || !github.issueComment) return;
      try { await github.issueComment(ev.issue.number, body); } catch { /* the issue already says what happened */ }
    };
    try {
      const id = pr ? String(pr) : sha.slice(0, 7);
      const base = config.default_branch;
      const { branch, subject } = await git.revertBranch({
        sha, branch: `agent/revert-${id}`, base, dirName: `revert-${id}`, worktreeDir: resolve(root, config.worktree_dir),
      });
      let title = subject;
      if (pr && github.prView) {
        try { title = (await github.prView(pr, ['title'])).title || subject; } catch { /* the commit subject will do */ }
      }
      ev.revertPr = await github.prCreate({
        title: `Revert ${pr ? `#${pr}` : sha.slice(0, 7)}: ${title}`, body: revertBody(ev, ev.issue, subject), head: branch, base, labels: ['needs-human'],
      });
      await comment(`Revert PR opened: ${ev.revertPr?.url ?? `#${ev.revertPr?.number}`}`);
    } catch (err) {
      ev.revertPrError = String(err?.message ?? err);
      await comment(`The revert PR could NOT be created automatically (${ev.revertPrError}). Revert \`${sha}\` by hand.`);
    }
  }

  const result = (outcome) => ({
    ok: outcome === 'merged',
    outcome,
    mergeSha: sha,
    deployment: ev.deployment,
    live: ev.live,
    issue: ev.issue,
    revertPr: ev.revertPr,
    smoke: ev.smoke ? { ok: ev.smoke.ok, tail: ev.smoke.tail } : null,
    ...(ev.knownGood || ev.rollback ? {
      recovery: { knownGood: ev.knownGood, liveBefore: ev.liveBefore, liveAfter: ev.liveAfter, rollback: ev.rollback },
    } : {}),
    ...(observe ? { observeOnly: true } : {}),
    ...(outcome === 'needs-owner' ? {
      evidence: {
        underlying: ev.underlying,
        failingDeployment: ev.deployment,
        liveDeployment: ev.liveBefore ?? ev.live,
        knownGood: ev.knownGood,
        smokeFailure: ev.smokeFailure ? { code: ev.smokeFailure.code, tail: ev.smokeFailure.tail } : null,
      },
    } : {}),
    ...(ev.reason ? { reason: ev.reason } : {}),
    ...(ev.issueError ? { issueError: ev.issueError } : {}),
    ...(ev.revertPrError ? { revertPrError: ev.revertPrError } : {}),
    ...(ev.warnings.length ? { warnings: ev.warnings } : {}),
  });
  const finish = async (outcome) => {
    await report(outcome);
    return result(outcome);
  };

  // 0. Observe-only after a rollback that already finished (the original watch died before `P summary`): production is
  // not what the merge shipped any more, so a fresh smoke would misreport it. Finish with what the attempt recorded; an
  // aborted attempt (the rollback never ran) or no attempt at all re-derives from scratch below.
  if (observe && events) {
    let recorded = null;
    try {
      const list = await events.list();
      recorded = resolvedRollbacks(list, { mergeSha: sha }).filter((e) => e.data?.aborted !== true).at(-1) ?? null;
      if (recorded) {
        const reported = list.filter((e) => e.kind === 'recovery-reported' && e.id === recorded.id && e.dataStatus === 'ok' && e.data?.mergeSha === sha).at(-1);
        const done = recorded.data.ok === true && recorded.data.verified === true;
        ev.issue = reported?.data?.issueUrl ? { url: reported.data.issueUrl } : null;
        ev.revertPr = reported?.data?.revertPrUrl ? { url: reported.data.revertPrUrl } : null;
        ev.reason = `a rollback already ran for this merge (${recorded.id}): ${done ? 'production was verified healthy on the known-good deployment' : `it ${recorded.data.ok === true ? 'ran but production was NOT verified' : 'FAILED'}`}; not re-checked`;
        const out = result(done ? 'recovered' : 'rollback-failed');
        return { ...out, recorded: { id: recorded.id, url: recorded.url ?? null, ok: recorded.data.ok === true, verified: recorded.data.verified === true } };
      }
    } catch (err) {
      // unreadable events: re-derive from scratch (the interrupted-rollback check after the watch warns about the same failure)
      note(`could not read the PR's rollback events: ${err?.message ?? err}`);
    }
  }

  // 1. The Production deployment of THIS merge.
  const found = await findDeployment({ sha, environment: prod.environment, timeoutMs: prod.deploy_timeout_minutes * 60_000 });
  if (found?.state !== 'success') {
    const failed = found?.state === 'failure';
    ev.deployment = failed ? { id: found.id ?? null, url: found.url ?? null, state: 'failure' } : null;
    ev.reason = failed ? null : `no successful ${prod.environment} deployment of ${sha.slice(0, 7)} within ${prod.deploy_timeout_minutes} minutes`;
    return finish(failed ? 'deploy-failed' : 'deploy-not-observed');
  }
  ev.deployment = { id: found.id ?? null, url: found.url ?? null, createdAt: found.createdAt ?? null, state: 'success' };

  // 2. Smoke production; a pass only counts once the live deployment is ours (or newer), re-smoked if we had to wait.
  let smoked = await smokeWithRetry();
  let smokedAgainstOlder = false;
  for (let looks = 0; smoked.ok;) {
    if (!managed) return finish('merged');
    let live = null;
    let why = null;
    try {
      live = await inspectAlias(domain);
      ev.live = live;
      const relation = await relate(live);
      if (relation === 'ours' || relation === 'newer') {
        if (!smokedAgainstOlder) return finish('merged');
        smoked = await smokeOnce(); // the smoke that passed ran against the OLD deployment; test the one that is live now
        smokedAgainstOlder = false;
        continue;
      }
      why = `production still serves ${describe(live)}, older than this merge`;
    } catch (err) {
      why = `could not read the live deployment: ${err?.message ?? err}`;
    }
    if (looks >= notLiveChecks) {
      ev.reason = `${why} after ${notLiveChecks} checks ${Math.round(retryWaitMs / 1000)}s apart`;
      return finish('not-live');
    }
    looks += 1;
    smokedAgainstOlder = true;
    note(`${why}; checking again in ${Math.round(retryWaitMs / 1000)}s (${looks}/${notLiveChecks})`);
    await sleep(retryWaitMs);
  }

  // 3-8. Smoke failed twice: recover, under the machine-wide production lock.
  async function recover() {
    if (!managed) return skip(`production.provider is "other": no Vercel to inspect or roll back. Run production.rollback.command by hand${prod.rollback?.command ? ` (${prod.rollback.command})` : ''}.`);
    let before;
    try {
      before = await inspectAlias(domain);
    } catch (err) {
      return skip(`could not read the live deployment, so ownership of production cannot be proven: ${err?.message ?? err}`);
    }
    ev.live = ev.liveBefore = before;
    if ((await relate(before)) !== 'ours') {
      // Vercel stops auto-assigning production after a rollback, so this merge's deployment may simply never have been
      // promoted: production still serves the known-good deployment. Rolling back to what is already live is a no-op
      // that would read as a failed rollback, so say "not live" instead.
      const early = await readKnown();
      if (early?.ok && ((early.url && hostOf(early.url) === hostOf(before.url)) || (early.id && before.id && early.id === String(before.id)))) {
        ev.knownGood = { id: early.id, sha: early.sha, url: early.url };
        ev.reason = `production still serves the known-good deployment ${describe(before)}: this merge's deployment was never promoted (Vercel stops auto-assigning production after a rollback), so there is nothing to roll back`;
        return 'not-live';
      }
      // The live deployment is not the one that failed; it may be a newer, healthy deploy that must not be rolled back.
      // It is not this merge's build, so the new build's expect-text does not apply.
      note('the live deployment is not this merge\'s; smoking it once more');
      if ((await smokeOnce(null)).ok) return 'superseded';
      ev.notes.push('A different deployment is live and also fails the smoke, so recovery continued.');
    }

    const known = await readKnown();
    if (!known?.ok) return skip(known?.reason ?? 'no known-good deployment recorded');
    ev.knownGood = { id: known.id, sha: known.sha, url: known.url };
    if (known.url && hostOf(known.url) === hostOf(ev.deployment.url)) return skip('the recorded known-good deployment is the failing deployment itself');

    // Immediately before acting: still the same deployment? If not, someone deployed or rolled back meanwhile.
    let again;
    try {
      again = await inspectAlias(domain);
    } catch (err) {
      return skip(`could not re-read the live deployment right before rollback: ${err?.message ?? err}`);
    }
    if (again.id !== before.id) {
      ev.live = ev.liveChanged = again;
      return 'changed-during-recovery';
    }

    // Observe-only stops here: this is exactly the point where a normal run would roll back.
    if (observe) {
      return skip(`observe-only: ${describe(again)} fails the production smoke and would be rolled back to ${known.url || known.id}; nothing was changed`, 'needs-owner');
    }

    // Record the intent on the PR BEFORE touching production: a rollback nobody recorded is exactly what strands a run.
    // No PR (events not wired) means there is no run to strand, so that case proceeds.
    if (events) {
      eventId = await nextEventId();
      try {
        await events.post('rollback-intent', eventId, `Rolling production back from ${describe(ev.deployment)} to ${known.url || known.id}.`, {
          mergeSha: sha,
          pr,
          failingDeployment: { id: ev.deployment.id, url: ev.deployment.url },
          target: { id: known.id, sha: known.sha, url: known.url },
          liveBefore: { id: before.id ?? null, url: before.url ?? null },
        });
      } catch (err) {
        ev.notes.push(`rollback-intent event failed: ${err?.message ?? err}`);
        return skip('could not record the rollback intent on the PR');
      }
    }

    // Posting the intent took GitHub round trips after the check above: look once more, right before acting. If
    // production moved, abort and close the intent so it is not left open (an intent with no result reads as interrupted).
    if (events) {
      let last = null;
      let readError = null;
      try {
        last = await inspectAlias(domain);
      } catch (err) {
        readError = err;
      }
      if (readError || last.id !== before.id) {
        if (last) ev.live = ev.liveChanged = last;
        await postAbortedRollback(last);
        if (readError) return skip(`could not re-read the live deployment after recording the rollback intent, so nothing was rolled back: ${readError?.message ?? readError}`);
        return 'changed-during-recovery';
      }
    }

    rollbackTried = true;
    let rb;
    try {
      rb = await rollback(known.url || known.id);
    } catch (err) {
      rb = { ok: false, code: null, tail: String(err?.message ?? err) };
    }
    ev.rollback = { ok: rb?.ok === true, code: rb?.code ?? null, tail: String(rb?.tail ?? '') };
    const outcome = ev.rollback.ok ? await verifyRollback(known) : skip('the rollback command failed', 'rollback-failed');
    await postRollbackResult(outcome === 'recovered');
    return outcome;
  }

  // After a rollback command that succeeded: did production really land on the known-good deployment, and does it pass?
  async function verifyRollback(known) {
    let after;
    try {
      after = await inspectAlias(domain);
    } catch (err) {
      return skip(`rollback ran but the live deployment could not be read back: ${err?.message ?? err}`, 'rollback-failed');
    }
    ev.live = ev.liveAfter = after;
    const landed = known.url ? hostOf(after.url) === hostOf(known.url) : after.id === known.id;
    if (!landed) return skip(`rollback ran but production serves ${describe(after)}, not the known-good deployment`, 'rollback-failed');
    // The rolled-back deployment is the OLD build: the new build's expect-text cannot be on it.
    if (!(await smokeWithRetry(null)).ok) return skip('production still fails the smoke after rollback', 'rollback-failed');
    return 'recovered';
  }

  // Event ids are `<sha7>-<n>`, n = 1 + the rollback-intents already on the PR for this merge (a retry never reuses one).
  async function nextEventId() {
    let n = 1;
    try {
      n += (await events.list()).filter((e) => e.kind === 'rollback-intent' && e.data?.mergeSha === sha).length;
    } catch { /* the id only has to be stable for this run */ }
    return `${sha.slice(0, 7)}-${n}`;
  }

  // Later events are evidence for the owner, not a gate: a failure to post one is a warning, never a different outcome.
  async function postLater(kind, sentence, data) {
    if (!events || !eventId) return;
    try {
      await events.post(kind, eventId, sentence(), data());
    } catch (err) {
      ev.warnings.push(`could not record the ${kind} event on the PR: ${err?.message ?? err}`);
    }
  }
  // The attempt's intent was recorded but the rollback never ran: close it, so the owner is not told it was interrupted.
  async function postAbortedRollback(live) {
    if (resultPosted || !eventId) return;
    resultPosted = true;
    await postLater('rollback-result', () => 'Rollback ABORTED before it ran: production changed after the intent was recorded, so nothing was rolled back.', () => ({
      mergeSha: sha,
      ok: false,
      aborted: true,
      liveAfter: live ? { id: live.id ?? null, url: live.url ?? null } : null,
      verified: false,
    }));
  }
  async function postRollbackResult(verified) {
    if (resultPosted || !eventId) return;
    resultPosted = true;
    await postLater('rollback-result', () => `Rollback ${ev.rollback?.ok ? 'ran' : 'FAILED'}; production ${verified ? 'verified healthy on the known-good deployment' : 'NOT verified'}.`, () => ({
      mergeSha: sha,
      ok: ev.rollback?.ok === true,
      liveAfter: ev.liveAfter ? { id: ev.liveAfter.id ?? null, url: ev.liveAfter.url ?? null } : null,
      verified,
    }));
  }

  // Observe-only writes nothing and changes nothing, so every outcome that wanted action from the owner (a failing smoke
  // that was, or would have been, rolled back) is the same thing: `needs-owner`, with what it would have been in evidence.
  const asObserved = (out) => {
    if (!observe || !PAUSING.has(out)) return out;
    ev.underlying = out;
    ev.reason ??= `observe-only: the production smoke fails (${out})`;
    return 'needs-owner';
  };

  const lockName = `prod-${String(config.project).replace(/[^A-Za-z0-9._-]/g, '-')}`;
  let entered = false;
  let outcome = null;
  // Observe-only is read-only, so it neither needs nor waits for the machine-wide recovery lock.
  const withProdLock = observe ? async (_name, fn) => fn() : lock;
  try {
    await withProdLock(lockName, async () => {
      entered = true;
      try {
        outcome = await recover();
      } catch (err) {
        ev.notes.push(`unexpected error during recovery: ${err?.stack ?? err}`);
        outcome = skip(`unexpected error during recovery: ${err?.message ?? err}`, rollbackTried ? 'rollback-failed' : 'rollback-skipped');
        if (rollbackTried) await postRollbackResult(false);
      }
      outcome = asObserved(outcome);
      await report(outcome);
      if (rollbackTried) {
        await postLater('recovery-reported', () => `Rollback recovery reported: incident issue ${ev.issue?.url ?? 'not created'}, revert PR ${ev.revertPr?.url ?? 'not created'}.`, () => ({
          mergeSha: sha, issueUrl: ev.issue?.url ?? null, revertPrUrl: ev.revertPr?.url ?? null,
        }));
      }
    });
  } catch (err) {
    if (!entered && err?.name === 'LockTimeoutError') {
      outcome = asObserved(skip(`could not get the production recovery lock ${lockName}: ${err.message}`));
      await report(outcome);
    } else if (entered && outcome && err?.name === 'LockLostError') {
      ev.warnings.push(err.message); // everything was already done and reported; the caller should just know
    } else {
      throw err;
    }
  }
  return result(outcome);
}
