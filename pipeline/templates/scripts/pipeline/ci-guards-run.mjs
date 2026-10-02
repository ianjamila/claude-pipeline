// Orchestrator the pipeline-guards workflow runs on a BASE checkout (never PR code): fetches the PR head as data,
// decides which human approval labels still count, runs both guards and publishes the two required commit statuses.
// Why approvals are computed here instead of read from the event: an approval must be bound to the commit it was given
// for. A label only counts if the repo owner applied it AFTER the head commit appeared (earliest check suite / status
// for that sha), so a push after approval silently invalidates it, and a collaborator or a stale label never passes.
// Everything is re-derived from the GitHub API on every run, so it does not depend on which event woke the workflow.
// The verdict lives in the statuses: exit 0 after publishing (even for "failure"), exit 1 only on an internal error
// (the workflow's `if: failure()` step then marks anything still pending as `error`).
// Who may approve: the logins in .claude/pipeline.yml ci.approvers; with no list, the repo owner of a USER-owned repo. An
// org-owned repo with no list fails closed (every approval ignored, reason org-repo-needs-ci.approvers), because an org
// name is never the login of whoever applies a label.
// Env: GH_TOKEN, REPO (owner/name), PR_NUMBER, EVENT_HEAD, BASE_SHA, RUN_URL, GITHUB_STEP_SUMMARY, OWNER_TYPE (optional:
// github.event.repository.owner.type, "User" | "Organization"; unset keeps the owner-login rule).
// Vendored into projects by `pipeline vendor` (imports ./lib/* and ./ci-guard.mjs).
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARDSTOP_LABEL, INTEGRITY_LABEL, MAX_DESCRIPTION, clip, runCheck } from './ci-guard.mjs';
import { loadConfig } from './lib/config.mjs';
import { git, revParse } from './lib/git.mjs';
import { gh as defaultGh, GhError } from './lib/proc.mjs';

export const CONTEXTS = { integrity: 'Test integrity', hardstops: 'Hard-stop scan' };
// Which check each approval label can override.
const APPROVAL_CHECK = { [INTEGRITY_LABEL]: 'integrity', [HARDSTOP_LABEL]: 'hardstops' };
const NOTES = {
  predates: 'approval predates the latest commit — re-apply',
  'not-owner': 'approval ignored: label not applied by the repo owner',
  'not-approver': 'approval ignored: label not applied by a login listed in ci.approvers',
  'org-repo-needs-ci.approvers': 'approval ignored: org-owned repo, list the approvers in ci.approvers (org-repo-needs-ci.approvers)',
  'no-event': 'approval ignored: no labeling event found',
  'no-head-time': 'approval ignored: cannot tell when the commit appeared',
};

const lines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);
const sameSet = (a, b) => {
  const [x, y] = [[...a].sort(), [...b].sort()];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function readEnv(env) {
  const need = (k) => {
    if (!env[k] || !String(env[k]).trim()) throw new Error(`missing environment variable ${k}`);
    return String(env[k]).trim();
  };
  const repo = need('REPO');
  const pr = need('PR_NUMBER');
  const head = need('EVENT_HEAD').toLowerCase();
  const base = need('BASE_SHA').toLowerCase();
  // These end up in API paths and git refspecs: accept only the exact shapes GitHub produces.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`REPO is not owner/name: ${repo}`);
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error(`PR_NUMBER is not a number: ${pr}`);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`EVENT_HEAD is not a full commit sha: ${head}`);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`BASE_SHA is not a full commit sha: ${base}`);
  const ownerType = env.OWNER_TYPE ? String(env.OWNER_TYPE).trim() : '';
  return { repo, pr, head, base, runUrl: env.RUN_URL ? String(env.RUN_URL).trim() : '', owner: repo.split('/')[0].toLowerCase(), ownerType };
}

/**
 * Runs the whole guard flow once. Returns { exitCode: 0, output }; throws on an internal error.
 * deps (tests): gh (proc.gh shape), check (passed to ci-guard runCheck).
 */
export async function runOrchestrator({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const { repo, pr, head, base, runUrl, owner, ownerType } = readEnv(env);
  const ghFn = deps.gh ?? defaultGh;

  const api = (args) => {
    const full = ['api', ...args];
    const r = ghFn(full, { cwd, env });
    if (r.code !== 0 || r.timedOut) throw new GhError({ code: r.code, stderr: r.stderr, args: full, timedOut: r.timedOut });
    return r.stdout;
  };
  const post = (state, context, description) => api([
    `repos/${repo}/statuses/${head}`,
    '-f', `state=${state}`,
    '-f', `context=${context}`,
    '-f', `description=${clip(description, MAX_DESCRIPTION)}`,
    ...(runUrl ? ['-f', `target_url=${runUrl}`] : []),
  ]);
  const currentHead = () => api([`repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim().toLowerCase();
  const listLabels = () => lines(api([`repos/${repo}/issues/${pr}/labels`, '--paginate', '--jq', '.[].name']));

  // A newer commit exists: this run's verdict would describe the wrong code, and the run for the new head decides.
  const superseded = () => {
    for (const context of Object.values(CONTEXTS)) post('error', context, 'superseded by a newer commit');
    return { exitCode: 0, output: { ok: true, superseded: true, head, base } };
  };

  // 1. The head must be the one the event named, in the fetched ref AND on GitHub right now.
  git(['fetch', '--no-tags', 'origin', `+refs/pull/${pr}/head:refs/remotes/pr/head`], { cwd });
  const fetched = revParse('refs/remotes/pr/head', { cwd }).toLowerCase();
  if (fetched !== head || currentHead() !== head) return superseded();

  // 2. Which approval labels still count.
  async function resolveApprovals(labels) {
    const present = Object.keys(APPROVAL_CHECK).filter((l) => labels.includes(l));
    if (present.length === 0) return { valid: [], invalid: [], headSeenAt: null };
    // Only read when an approval label is actually present. An unreadable config is an internal error (fail closed).
    const loaded = await (deps.loadConfig ?? loadConfig)(cwd);
    if (!loaded.ok) throw new Error(`invalid or missing .claude/pipeline.yml: ${loaded.errors.join('; ')}`);
    const approvers = (loaded.config.ci?.approvers ?? []).map((l) => l.toLowerCase());
    const orgWithoutList = approvers.length === 0 && ownerType !== '' && ownerType !== 'User';
    const stamps = [
      ...lines(api([`repos/${repo}/commits/${head}/check-suites`, '--paginate', '--jq', '.check_suites[].created_at'])),
      ...lines(api([`repos/${repo}/commits/${head}/statuses`, '--paginate', '--jq', '.[].created_at'])),
    ].map((s) => Date.parse(s)).filter(Number.isFinite);
    const headSeenAt = stamps.length > 0 ? Math.min(...stamps) : null;
    const events = lines(api([
      `repos/${repo}/issues/${pr}/events`, '--paginate', '--jq',
      '.[] | select(.event == "labeled") | {label: .label.name, actor: .actor.login, at: .created_at} | @json',
    ])).map((l) => JSON.parse(l));

    const valid = [];
    const invalid = [];
    for (const label of present) {
      const latest = events
        .filter((e) => e.label === label && Number.isFinite(Date.parse(e.at)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      let reason = null;
      const actor = String(latest?.actor ?? '').toLowerCase();
      if (orgWithoutList) reason = 'org-repo-needs-ci.approvers';
      else if (headSeenAt === null) reason = 'no-head-time';
      else if (!latest) reason = 'no-event';
      else if (approvers.length > 0 ? !approvers.includes(actor) : actor !== owner) reason = approvers.length > 0 ? 'not-approver' : 'not-owner';
      else if (!(Date.parse(latest.at) > headSeenAt)) reason = 'predates';
      if (reason) invalid.push({ label, reason });
      else valid.push(label);
    }
    return { valid, invalid, headSeenAt };
  }

  // 3. Both guards, with ONLY the valid approvals visible to them.
  async function evaluatePass() {
    const labels = listLabels();
    const approvals = await resolveApprovals(labels);
    const results = {};
    for (const check of Object.keys(CONTEXTS)) {
      results[check] = await runCheck({ check, base, head, labels: approvals.valid, cwd, deps: deps.check });
    }
    return { labels, approvals, results };
  }

  let pass = await evaluatePass();

  // 4. Re-read before publishing: a push or a label change while we worked must not be published over.
  if (currentHead() !== head) return superseded();
  if (!sameSet(listLabels(), pass.labels)) pass = await evaluatePass();

  // 5. Publish. The note for an ignored approval goes on the status of the check that approval would have overridden.
  const noteFor = (check) => {
    const bad = pass.approvals.invalid.filter((a) => APPROVAL_CHECK[a.label] === check);
    return bad.length > 0 ? [...new Set(bad.map((a) => NOTES[a.reason]))].join('; ') : '';
  };
  const published = {};
  for (const [check, context] of Object.entries(CONTEXTS)) {
    const r = pass.results[check];
    const state = r.exitCode === 0 ? 'success' : r.exitCode === 1 ? 'failure' : 'error';
    const note = noteFor(check);
    const description = note ? `${clip(r.description, MAX_DESCRIPTION - note.length - 2)}; ${note}` : r.description;
    post(state, context, description);
    published[check] = { context, state, description: clip(description, MAX_DESCRIPTION) };
  }

  const summary = [
    ...Object.values(pass.results).map((r) => r.summary),
    ...(pass.approvals.invalid.length > 0
      ? [`## Approvals ignored\n\n${pass.approvals.invalid.map((a) => `- \`${a.label}\`: ${NOTES[a.reason]}`).join('\n')}\n`]
      : []),
  ].join('\n');
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`); } catch (err) { process.stderr.write(`could not write step summary: ${err.message}\n`); }
  }

  // Last, and best effort: removing a label fires `unlabeled`, which starts (and cancels this) run, so the verdict
  // must already be on record. The next run sees the cleaned label set and reaches the same verdict.
  const removed = [];
  for (const { label } of pass.approvals.invalid) {
    try {
      api(['-X', 'DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(label)}`]);
      removed.push(label);
    } catch (err) {
      process.stderr.write(`could not remove label ${label}: ${err.message}\n`);
    }
  }

  return {
    exitCode: 0,
    output: {
      ok: Object.values(published).every((p) => p.state === 'success'),
      head,
      base,
      results: published,
      approvals: { valid: pass.approvals.valid, ignored: pass.approvals.invalid, removed, headSeenAt: pass.approvals.headSeenAt === null ? null : new Date(pass.approvals.headSeenAt).toISOString() },
    },
  };
}

export async function main(env = process.env) {
  try {
    const r = await runOrchestrator({ env });
    process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
    return r.exitCode;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'internal', message: String(err?.message ?? err) }, null, 2)}\n`);
    process.stderr.write(`ci-guards-run failed: ${err?.message ?? err}\n`);
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
