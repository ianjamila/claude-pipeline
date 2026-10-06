// Orchestrator the pipeline-guards workflow runs on a BASE checkout (never PR code): fetches the PR head as data,
// decides which human approval labels still count, runs both guards and publishes the two required commit statuses.
// Why approvals are bound by a RECEIPT: an approval must cover exactly the commit the owner reviewed. When a `labeled`
// event for an approval label (human-approved, test-change-approved) arrives from an allowed approver and the event's
// head is still the PR's head, the FIRST thing this run does is post a commit status `pipeline-approval: <label>` on
// that head sha (the receipt). A label then counts for head H only if (a) it is present, (b) its latest `labeled`
// event was by an allowed approver, (c) a receipt for it exists ON H, created by github-actions[bot] (a status posted
// with a human's or agent's token does not count), (d) the receipt is not older than that latest `labeled` event
// (it was posted in response to that very labeling), and (e) the receipt's target_url is a run of the pipeline-guards
// workflow, triggered by pull_request_target, from a commit on the default branch, listing THIS PR at THIS head with the
// default branch as base, and running when the receipt was posted (lib/guard-provenance.mjs), and (f) its description
// names the label and the approver of the latest labeling, which happened inside that run's window. (e) matters
// because pull_request_target reads the workflow from the PR's BASE branch: an agent can push branch x with an edited
// workflow and open a PR into x on the same head sha, and that run posts bot statuses on the shared head. Statuses are per sha, so an approval on A can never cover a
// descendant B, however early B appeared elsewhere (another branch, a fork PR): the old "label is later than the
// earliest check suite of the head" rule was bypassable that way and is gone. A remove + re-add is a new labeled event,
// hence a new receipt. If the labeled run is cancelled before the receipt is posted (a newer event for the same PR
// cancels it) the approval simply does not count and the label is removed with the note "re-apply the label" (fail
// closed). Residual: the workflow token is the trust anchor - anything that can post a status as github-actions[bot]
// (for instance a workflow of a same-repo PR that declares statuses: write) could also post the two required statuses
// directly; and an approver whose browser tab is stale can label a head they did not review (the receipt records the
// head the event named). Everything is re-derived from the GitHub API on every run, so it does not depend on which
// event woke the workflow, except that only the labeled event itself can create a receipt.
// The verdict lives in the statuses: exit 0 after publishing (even for "failure"), exit 1 only on an internal error
// (the workflow's `if: failure()` step then marks anything still pending as `error`).
// Who may approve: the logins in .claude/pipeline.yml ci.approvers; with no list, the repo owner of a USER-owned repo. An
// org-owned repo with no list fails closed (every approval ignored, reason org-repo-needs-ci.approvers), because an org
// name is never the login of whoever applies a label.
// Env: GH_TOKEN, REPO (owner/name), PR_NUMBER, EVENT_HEAD, BASE_SHA, RUN_URL, GITHUB_STEP_SUMMARY, OWNER_TYPE (optional:
// github.event.repository.owner.type, "User" | "Organization"; unset keeps the owner-login rule), and for receipts
// EVENT_ACTION / EVENT_LABEL / EVENT_SENDER (github.event.action, .label.name, .sender.login; empty for other events).
// Vendored into projects by `pipeline vendor` (imports ./lib/* and ./ci-guard.mjs).
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARDSTOP_LABEL, INTEGRITY_LABEL, MAX_DESCRIPTION, clip, runCheck } from './ci-guard.mjs';
import { loadConfig } from './lib/config.mjs';
import { checkRunProvenance, withinRunWindow } from './lib/guard-provenance.mjs';
import { git, revParse } from './lib/git.mjs';
import { gh as defaultGh, GhError } from './lib/proc.mjs';

export const CONTEXTS = { integrity: 'Test integrity', hardstops: 'Hard-stop scan' };
// Which check each approval label can override.
const APPROVAL_CHECK = { [INTEGRITY_LABEL]: 'integrity', [HARDSTOP_LABEL]: 'hardstops' };
// The receipt status context for an approval label: "pipeline-approval: human-approved".
export const receiptContext = (label) => `pipeline-approval: ${label}`;
// The receipt names the label and the approver, so it can be matched to the labeling event it answers.
export const receiptDescription = (label, login) => `${label} approved by ${login}`;
const RECEIPT_CREATOR = 'github-actions[bot]';
const NOTES = {
  'no-receipt': 'approval not recorded for this commit — re-apply the label',
  'not-owner': 'approval ignored: label not applied by the repo owner',
  'not-approver': 'approval ignored: label not applied by a login listed in ci.approvers',
  'org-repo-needs-ci.approvers': 'approval ignored: org-owned repo, list the approvers in ci.approvers (org-repo-needs-ci.approvers)',
  'no-event': 'approval ignored: no labeling event found',
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
  // The labeling event (empty for every other event). The label name is only ever compared to the two known labels.
  const action = env.EVENT_ACTION ? String(env.EVENT_ACTION).trim() : '';
  const label = env.EVENT_LABEL ? String(env.EVENT_LABEL).trim().slice(0, 200) : '';
  const sender = env.EVENT_SENDER ? String(env.EVENT_SENDER).trim() : '';
  if (action && !/^[a-z_]{1,40}$/.test(action)) throw new Error(`EVENT_ACTION is not an action name: ${action}`);
  if (sender && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?(?:\[bot\])?$/.test(sender)) throw new Error(`EVENT_SENDER is not a login: ${sender}`);
  return { repo, pr, head, base, action, label, sender, runUrl: env.RUN_URL ? String(env.RUN_URL).trim() : '', owner: repo.split('/')[0].toLowerCase(), ownerType };
}

/**
 * Runs the whole guard flow once. Returns { exitCode: 0, output }; throws on an internal error.
 * deps (tests): gh (proc.gh shape), check (passed to ci-guard runCheck).
 */
export async function runOrchestrator({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const { repo, pr, head, base, action, label: eventLabel, sender, runUrl, owner, ownerType } = readEnv(env);
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

  // Who may approve. An unreadable config is an internal error (fail closed). Only read when it is needed.
  async function approverPolicy() {
    const loaded = await (deps.loadConfig ?? loadConfig)(cwd);
    if (!loaded.ok) throw new Error(`invalid or missing .claude/pipeline.yml: ${loaded.errors.join('; ')}`);
    const approvers = (loaded.config.ci?.approvers ?? []).map((l) => l.toLowerCase());
    const orgWithoutList = approvers.length === 0 && ownerType !== '' && ownerType !== 'User';
    const allowed = (login) => !orgWithoutList && (approvers.length > 0 ? approvers.includes(login) : login === owner);
    return { approvers, orgWithoutList, allowed };
  }

  // 2a. The receipt: record, on THIS head, that an allowed approver applied this approval label to it. Posted before
  // anything is evaluated, so a later cancellation cannot leave a half-recorded approval (it leaves none).
  if (action === 'labeled' && Object.hasOwn(APPROVAL_CHECK, eventLabel) && sender) {
    const policy = await approverPolicy();
    if (policy.allowed(sender.toLowerCase())) {
      // The run URL is the receipt's provenance: a receipt without one could never be verified, so it is not posted.
      if (!runUrl) throw new Error('RUN_URL is required to post an approval receipt');
      post('success', receiptContext(eventLabel), receiptDescription(eventLabel, sender));
    }
  }

  // 2b. Which approval labels still count.
  async function resolveApprovals(labels) {
    const present = Object.keys(APPROVAL_CHECK).filter((l) => labels.includes(l));
    if (present.length === 0) return { valid: [], invalid: [] };
    const { approvers, orgWithoutList } = await approverPolicy();
    const receipts = lines(api([
      `repos/${repo}/commits/${head}/statuses`, '--paginate', '--jq',
      '.[] | select((.context | startswith("pipeline-approval: ")) and .state == "success") | {context: .context, by: .creator.login, at: .created_at, url: .target_url, description: .description} | @json',
    ])).map((l) => JSON.parse(l));
    const provenanceCache = new Map();
    const read = (path, jq) => api([path, '--jq', jq]);
    // (e) The receipt's run is verified AND bound to this PR/head/time; (f) the receipt names this label and the approver of
    // the latest labeling, and that labeling happened while the run was going (so the run answers that very event).
    const receiptOk = (r, label, latest) => {
      const note = (why) => { process.stderr.write(`ignoring receipt ${r.context} (${r.at}): ${why}\n`); return false; };
      const verdict = checkRunProvenance({ read, repo, url: r.url, bind: { prNumber: pr, headSha: head, createdAt: r.at }, cache: provenanceCache });
      if (!verdict.ok) return note(verdict.reason);
      if (String(r.description ?? '').toLowerCase() !== receiptDescription(label, latest.actor).toLowerCase()) return note('its description does not name this label and the approver of the latest labeling');
      if (!withinRunWindow(verdict.window, latest.at)) return note('the labeling happened outside the window of the run that posted it');
      return true;
    };
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
      else if (!latest) reason = 'no-event';
      else if (approvers.length > 0 ? !approvers.includes(actor) : actor !== owner) reason = approvers.length > 0 ? 'not-approver' : 'not-owner';
      else if (!receipts.some((r) => r.context === receiptContext(label) && r.by === RECEIPT_CREATOR && Date.parse(r.at) >= Date.parse(latest.at) && receiptOk(r, label, latest))) reason = 'no-receipt';
      if (reason) invalid.push({ label, reason });
      else valid.push(label);
    }
    return { valid, invalid };
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
      approvals: { valid: pass.approvals.valid, ignored: pass.approvals.invalid, removed },
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
