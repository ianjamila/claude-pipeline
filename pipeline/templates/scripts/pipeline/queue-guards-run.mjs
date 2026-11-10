// The trusted poster the queue-guards workflow runs (`workflow_run`, so GitHub always runs the DEFAULT BRANCH's copy and never
// the queue commit's). It puts the three guard statuses (`Test integrity`, `Hard-stop scan`, `Cross-model review` with
// ci.review_check) on a merge-queue commit, which has no pull_request_target run of its own.
// A queue commit is green for a guard only when EVERY member PR has that guard green from the real pipeline-guards run on its
// exact queued head: the same checkGuardVerdict the merge gate uses, per member and context. Members come from GitHub's own
// queue-entry records (lib/queue-members.mjs), never from commit text. Anything unknown is `error`, never `success`.
// TWO PHASES, like ci-guards-run.mjs, so the verdict is bound to an artifact only this run can upload:
//   evaluate (default): posts `pending` per context, builds the manifest, judges member x context (a member status still
//     `pending`, e.g. the hold lift's `unlabeled` re-run, is polled every 30 s until it settles or the deadline nears: Fable F7),
//     writes verdict.json into $PIPELINE_VERDICT_DIR and appends `artifact=<name>` to $GITHUB_OUTPUT
//     (guard-provenance.mjs#queueVerdictArtifactName). The workflow uploads that file under that name.
//   --publish (after the upload): re-reads the queue (a predecessor merging is normal progress, anything else moving is an error),
//     then posts the statuses with target_url = this run. A status therefore never exists without its artifact.
//   --publish --error "<msg>": the workflow's failure step: every context `error` with the message.
// GITHUB_RUN_ATTEMPT !== '1' posts nothing in any phase (Fable F8): checkQueueVerdict rejects re-runs, and a re-run may execute an
// older copy of this script, so its green would read as a bypass. Re-queue the PR instead.
// Env: QUEUE_SHA, QUEUE_REF, QUEUE_EVENT, GITHUB_REPOSITORY, RUN_URL, GH_TOKEN, PIPELINE_VERDICT_DIR (or RUNNER_TEMP), GITHUB_OUTPUT,
// GITHUB_RUN_ATTEMPT; tests may shorten QUEUE_POLL_MS / QUEUE_PENDING_WAIT_MS.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_DESCRIPTION, clip } from './ci-guard.mjs';
import { CONTEXTS, REVIEW_KEY, VERDICT_FILE } from './ci-guards-run.mjs';
import { loadConfig } from './lib/config.mjs';
import { GUARD_CONTEXT_CHECKS, REVIEW_STATES, VERDICT_STATES, checkGuardVerdict, queueVerdictArtifactName } from './lib/guard-provenance.mjs';
import { gh as defaultGh, GhError } from './lib/proc.mjs';
import { memberStanding, parseQueueRef, queueManifest, recheckManifest } from './lib/queue-members.mjs';
import { REVIEW_CONTEXT } from './lib/review-marker.mjs';

// A member carrying one of these labels (the merge gate's blockers that stop a merge, see finalgate.mjs#BLOCKING_LABELS) or an open
// issue with one of these labels fails the group: the queue must honour a stop condition set while the PR waits.
export const BLOCKER_LABELS = Object.freeze(['needs-human', 'pipeline-blocked']);
export const BLOCKER_ISSUE_LABELS = Object.freeze(['pipeline-pause', 'pipeline-rollback']);
const BOT = 'github-actions[bot]';
const SHA = /^[0-9a-f]{40}$/;
const REASON_MAX = 80;
const DEFAULT_POLL_MS = 30_000;
// The job's timeout is 10 minutes; leave the rest for the manifest, the upload and --publish.
const DEFAULT_WAIT_MS = 7 * 60_000;

const KEYS = [...Object.keys(CONTEXTS), REVIEW_KEY];
const contextOf = (key) => (key === REVIEW_KEY ? REVIEW_CONTEXT : CONTEXTS[key]);
const lines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);
const first = (err) => String(err?.message ?? err).split('\n')[0];
const positive = (raw, fallback) => (/^[1-9][0-9]{0,9}$/.test(String(raw ?? '').trim()) ? Number(String(raw).trim()) : fallback);

function readEnv(env) {
  const need = (k) => {
    if (!env[k] || !String(env[k]).trim()) throw new Error(`missing environment variable ${k}`);
    return String(env[k]).trim();
  };
  const repo = need('GITHUB_REPOSITORY');
  const queueSha = need('QUEUE_SHA').toLowerCase();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`GITHUB_REPOSITORY is not owner/name: ${repo}`);
  if (!SHA.test(queueSha)) throw new Error(`QUEUE_SHA is not a full commit sha: ${queueSha}`);
  return {
    repo, queueSha,
    ref: String(env.QUEUE_REF ?? '').trim(),
    event: String(env.QUEUE_EVENT ?? '').trim(),
    runUrl: env.RUN_URL ? String(env.RUN_URL).trim() : '',
    pollMs: positive(env.QUEUE_POLL_MS, DEFAULT_POLL_MS),
    waitMs: positive(env.QUEUE_PENDING_WAIT_MS, DEFAULT_WAIT_MS),
  };
}

function verdictDir(env) {
  if (env.PIPELINE_VERDICT_DIR && String(env.PIPELINE_VERDICT_DIR).trim()) return String(env.PIPELINE_VERDICT_DIR).trim();
  if (env.RUNNER_TEMP && String(env.RUNNER_TEMP).trim()) return join(String(env.RUNNER_TEMP).trim(), 'queue-verdict');
  throw new Error('missing environment variable PIPELINE_VERDICT_DIR (or RUNNER_TEMP)');
}

// The attempt rule (F8), before anything else. Returns the skip result, or null when attempt 1.
function attemptSkip(env) {
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim();
  if (attempt === '1') return null;
  process.stderr.write(`attempt ${attempt || '(unknown)'} never posts; re-queue the PR instead\n`);
  return { exitCode: 0, output: { ok: true, skipped: 'attempt', attempt: attempt || null } };
}

function session({ env, cwd, deps }, { repo, queueSha, runUrl }) {
  const ghFn = deps.gh ?? defaultGh;
  const api = (args) => {
    const full = ['api', ...args];
    const r = ghFn(full, { cwd, env });
    if (r.code !== 0 || r.timedOut) throw new GhError({ code: r.code, stderr: r.stderr, args: full, timedOut: r.timedOut });
    return r.stdout;
  };
  const read = (path, jq) => api([path, '--jq', jq]);
  const graphql = (query, variables = {}) => JSON.parse(api(['graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([k, v]) => ['-f', `${k}=${v}`])]));
  const post = (state, context, description) => api([
    `repos/${repo}/statuses/${queueSha}`,
    '-f', `state=${state}`,
    '-f', `context=${context}`,
    '-f', `description=${clip(description, MAX_DESCRIPTION)}`,
    ...(runUrl ? ['-f', `target_url=${runUrl}`] : []),
  ]);
  const defaultBranch = () => read(`repos/${repo}`, '.default_branch').trim();
  return { api, read, graphql, post, defaultBranch };
}

// Is this run about a queue commit at all? { skip: result } or { defaultBranch }.
function queueRun(s, { event, ref }) {
  if (event !== 'merge_group') return { skip: { exitCode: 0, output: { ok: true, skipped: 'not a merge_group run' } } };
  const defaultBranch = s.defaultBranch();
  if (!defaultBranch || /\s/.test(defaultBranch)) throw new Error('the default branch could not be read');
  if (!parseQueueRef(ref, defaultBranch)) return { skip: { exitCode: 0, output: { ok: true, skipped: 'not a queue ref' } } };
  return { defaultBranch };
}

// Which contexts this repo posts: the review one only with ci.review_check in the base config. null = the config is unreadable
// (then the caller fails closed on all three).
async function reviewOn({ cwd, deps }) {
  const loaded = await (deps.loadConfig ?? loadConfig)(cwd);
  return loaded.ok ? loaded.config?.ci?.review_check === true : null;
}

const worst = (results) => (results.some((r) => r.state === 'error') ? 'error' : results.some((r) => r.state === 'failure') ? 'failure' : 'success');

/**
 * Evaluate. Returns { exitCode, output }; throws on an internal error (nothing is judged then; the workflow's failure step posts errors).
 * deps (tests): gh (proc.gh shape), loadConfig, sleep, now.
 */
export async function runEvaluate({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const skipped = attemptSkip(env);
  if (skipped) return skipped;
  const e = readEnv(env);
  const s = session({ env, cwd, deps }, e);
  const run = queueRun(s, e);
  if (run.skip) return run.skip;
  const { defaultBranch } = run;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + e.waitMs;

  const review = await reviewOn({ cwd, deps });
  const keys = review === false ? Object.keys(CONTEXTS) : KEYS; // unreadable config: all three, fail closed
  for (const key of keys) s.post('pending', contextOf(key), 'checking the member PRs');

  const checks = {};
  const finish = (manifest) => {
    for (const key of KEYS) if (!checks[key]) checks[key] = { state: 'off', description: 'not checked (ci.review_check is off)' };
    const dir = verdictDir(env);
    mkdirSync(dir, { recursive: true });
    const verdict = {
      version: 1, queueSha: e.queueSha, ref: e.ref, base: manifest?.base ?? null, members: manifest?.members ?? null,
      checks,
    };
    writeFileSync(join(dir, VERDICT_FILE), `${JSON.stringify(verdict, null, 2)}\n`);
    const artifact = queueVerdictArtifactName({ queueSha: e.queueSha, integrity: checks.integrity.state, hardstops: checks.hardstops.state, review: checks[REVIEW_KEY].state });
    if (!env.GITHUB_OUTPUT || !String(env.GITHUB_OUTPUT).trim()) throw new Error('missing environment variable GITHUB_OUTPUT');
    appendFileSync(env.GITHUB_OUTPUT, `artifact=${artifact}\n`);
    return { exitCode: 0, output: { ok: keys.every((k) => checks[k].state === 'success'), queueSha: e.queueSha, artifact, members: manifest?.members?.map((m) => m.pr) ?? null, results: Object.fromEntries(keys.map((k) => [k, checks[k]])) } };
  };
  const allUnknown = (why) => {
    for (const key of keys) checks[key] = { state: 'error', description: clip(`members unknown: ${why}`, MAX_DESCRIPTION) };
    return finish(null);
  };

  if (review === null) return allUnknown('invalid or missing .claude/pipeline.yml');
  const m = queueManifest({ read: s.read, graphql: s.graphql, repo: e.repo, defaultBranch, queueSha: e.queueSha, queueRef: e.ref });
  if (!m.ok) return allUnknown(m.reason);
  const { manifest } = m;

  // Stop conditions: a member label, or an open pause / rollback issue. (Read errors count as unknown, never as clear.)
  const blockers = new Map();
  for (const member of manifest.members) {
    try {
      const labels = lines(s.api([`repos/${e.repo}/issues/${member.pr}/labels`, '--paginate', '--jq', '.[].name'])).map((l) => l.toLowerCase());
      const hit = BLOCKER_LABELS.filter((l) => labels.includes(l));
      if (hit.length > 0) blockers.set(member.pr, { state: 'failure', reason: `labelled ${hit.join(', ')}` });
    } catch (err) {
      blockers.set(member.pr, { state: 'error', reason: `labels unreadable: ${first(err)}` });
    }
  }
  let issueBlocker = null;
  for (const label of BLOCKER_ISSUE_LABELS) {
    try {
      const n = s.read(`repos/${e.repo}/issues?state=open&labels=${label}&per_page=100`, '[.[] | select(.pull_request | not) | .number][0] // empty').trim();
      if (n) issueBlocker = { state: 'failure', reason: `open ${label} issue #${n}` };
    } catch (err) {
      issueBlocker = { state: 'error', reason: `${label} issues unreadable: ${first(err)}` };
    }
    if (issueBlocker) break;
  }

  // One member x context. `pending` is not a verdict: the caller polls it.
  const provenanceCache = new Map();
  const judgeOnce = (member, key) => {
    const context = contextOf(key);
    try {
      const latest = JSON.parse(s.read(`repos/${e.repo}/commits/${member.head}/statuses?per_page=100`,
        `[.[] | select(.context == "${context}")][0] | {state: .state, by: .creator.login, at: .created_at, url: .target_url}`));
      if (!latest) return { state: 'failure', reason: `no ${context} status on its head` };
      if (latest.state === 'pending') return { pending: true };
      if (latest.state !== 'success') return { state: 'failure', reason: `${context} is ${latest.state}` };
      if (latest.by !== BOT) return { state: 'failure', reason: `${context} was posted by ${latest.by ?? 'an unknown creator'}, not ${BOT}` };
      const v = checkGuardVerdict({ read: s.read, repo: e.repo, url: latest.url, bind: { prNumber: member.pr, headSha: member.head, createdAt: latest.at }, expect: { check: GUARD_CONTEXT_CHECKS[context] }, cache: provenanceCache });
      return v.ok ? { state: 'success' } : { state: 'failure', reason: v.reason };
    } catch (err) {
      return { state: 'error', reason: `${context} unreadable: ${first(err)}` };
    }
  };
  // A predecessor that merged after the manifest was taken (eaglewatch#1769): GitHub empties pull_requests on its guard runs, so its provenance can no longer be
  // checked, and it need not be. A member that has LEFT the queue merged at its OWN queue commit, with that commit on the default branch, is settled (it merged on its own
  // entry's green statuses); one that left any other way is an error. A live member keeps the full check. Read only when the check did not already pass, and kept once settled.
  const standings = new Map();
  const standingOf = (member) => {
    const known = standings.get(member.pr);
    if (known) return known;
    const st = memberStanding({ read: s.read, graphql: s.graphql, repo: e.repo, defaultBranch, queueSha: e.queueSha, member });
    if (st.kind === 'settled' || st.kind === 'gone') standings.set(member.pr, st);
    return st;
  };
  const overruled = (member) => {
    const st = standingOf(member);
    if (st.kind === 'settled') return { state: 'success', settled: true };
    return st.kind === 'gone' ? { state: 'error', reason: st.reason } : null;
  };
  const judge = async (member, key) => {
    const blocker = blockers.get(member.pr) ?? issueBlocker;
    if (blocker) return overruled(member) ?? blocker;
    for (;;) {
      const r = judgeOnce(member, key);
      if (r.state === 'success') return r;
      const settled = overruled(member);
      if (settled) return settled;
      if (!r.pending) return r;
      if (now() + e.pollMs >= deadline) return { state: 'failure', reason: `${contextOf(key)} is still pending` };
      await sleep(e.pollMs);
    }
  };

  for (const key of keys) {
    const results = [];
    for (const member of manifest.members) results.push({ member, ...(await judge(member, key)) });
    const state = worst(results);
    const description = state === 'success'
      ? `earned on their heads by ${manifest.members.map((x) => `#${x.pr}${standings.get(x.pr)?.kind === 'settled' ? ' (merged)' : ''}`).join(', ')}`
      : results.filter((r) => r.state !== 'success').map((r) => `#${r.member.pr}: ${clip(r.reason, REASON_MAX)}`).join('; ');
    checks[key] = { state, description: clip(description, MAX_DESCRIPTION) };
  }
  return finish(manifest);
}

/**
 * --publish. Posts what Evaluate recorded unless the queue moved (then `error`); exit 1 only when a post (or the verdict file) fails.
 * With `errorMessage` (the failure step): every context `error` with that message instead.
 */
export async function runPublish({ env = process.env, cwd = process.cwd(), deps = {}, errorMessage = null } = {}) {
  const skipped = attemptSkip(env);
  if (skipped) return skipped;
  const e = readEnv(env);
  const s = session({ env, cwd, deps }, e);
  let run;
  try {
    run = queueRun(s, e);
  } catch (err) {
    // The failure step still posts: an error status is the safe direction when the default branch cannot be read.
    if (errorMessage === null) throw err;
    run = { defaultBranch: null };
  }
  if (run.skip) return run.skip;

  let verdict = null;
  try {
    verdict = JSON.parse(readFileSync(join(verdictDir(env), VERDICT_FILE), 'utf8'));
  } catch (err) {
    if (errorMessage === null) throw new Error(`no readable verdict from the evaluate step: ${err.message}`);
  }
  const shape = verdict?.version === 1 && verdict.queueSha === e.queueSha
    && ['integrity', 'hardstops'].every((k) => VERDICT_STATES.includes(verdict.checks?.[k]?.state) && typeof verdict.checks[k].description === 'string')
    && REVIEW_STATES.includes(verdict.checks?.[REVIEW_KEY]?.state) && typeof verdict.checks[REVIEW_KEY].description === 'string'
    && (verdict.members === null || Array.isArray(verdict.members));
  if (!shape && errorMessage === null) throw new Error('the verdict file does not describe this queue commit');

  // Which contexts to post: the verdict's, else (failure step without a usable verdict) the config's, else all three.
  let keys;
  if (shape) keys = KEYS.filter((k) => verdict.checks[k].state !== 'off');
  else {
    let on = null;
    try { on = await reviewOn({ cwd, deps }); } catch { /* unknown: all three */ }
    keys = on === false ? Object.keys(CONTEXTS) : KEYS;
  }

  let planned;
  if (errorMessage !== null) planned = keys.map((k) => [k, 'error', errorMessage]);
  else {
    let moved = null;
    if (verdict.members !== null) {
      const re = recheckManifest({ read: s.read, graphql: s.graphql, repo: e.repo, defaultBranch: run.defaultBranch, manifest: { queueSha: e.queueSha, base: verdict.base, members: verdict.members } });
      if (!re.ok) moved = re.reason.startsWith("a member's head or entry moved") ? re.reason : `members unknown: ${re.reason}`;
    }
    planned = keys.map((k) => (moved ? [k, 'error', moved] : [k, verdict.checks[k].state, verdict.checks[k].description]));
  }

  const posted = {};
  const failed = [];
  for (const [key, state, description] of planned) {
    try {
      s.post(state, contextOf(key), description);
      posted[key] = { context: contextOf(key), state, description: clip(description, MAX_DESCRIPTION) };
    } catch (err) {
      failed.push(`${contextOf(key)}: ${first(err)}`);
    }
  }
  if (failed.length > 0) {
    process.stderr.write(`could not post: ${failed.join('; ')}\n`);
    return { exitCode: 1, output: { ok: false, error: 'post-failed', message: failed.join('; '), results: posted } };
  }
  return { exitCode: 0, output: { ok: Object.values(posted).every((p) => p.state === 'success'), queueSha: e.queueSha, results: posted } };
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  try {
    const publish = argv.includes('--publish');
    const errAt = argv.indexOf('--error');
    const errorMessage = errAt >= 0 ? String(argv[errAt + 1] ?? '') : null;
    const rest = argv.filter((a, i) => a !== '--publish' && a !== '--error' && !(errAt >= 0 && i === errAt + 1));
    if (rest.length > 0) throw new Error(`unknown argument ${rest[0]}`);
    if (errAt >= 0 && (!publish || !errorMessage)) throw new Error('--error needs --publish and a message');
    const r = publish ? await runPublish({ env, errorMessage }) : await runEvaluate({ env });
    process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
    return r.exitCode;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'internal', message: first(err) }, null, 2)}\n`);
    process.stderr.write(`queue-guards-run failed: ${err?.message ?? err}\n`);
    return 1;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; });
}
