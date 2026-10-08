// Orchestrator the pipeline-guards workflow runs on a BASE checkout (never PR code): fetches the PR head as data,
// decides which human approval labels still count, runs both guards and publishes the two required commit statuses.
// TWO PHASES, so the verdict can be bound to an artifact only this run can upload (issue #3):
//   phase 1 (default): everything below except publishing. Writes `verdict.json` (the PR, head, base, the per-check state
//     and description, the labels to remove, the receipt this process posted) into $PIPELINE_VERDICT_DIR (default
//     $RUNNER_TEMP/pipeline-verdict) and appends `artifact=<name>` to $GITHUB_OUTPUT: the name carries the head, both
//     states and the receipt (verdictArtifactName in lib/guard-provenance.mjs). The workflow then uploads that file under
//     that name (actions/upload-artifact).
//   phase 2 (`--publish`, after the upload succeeded): re-checks that the PR head is still the verdict's, posts the two
//     statuses, and only then removes invalid approval labels. A status therefore never exists without its artifact, and
//     the final gate / later runs accept a status only when the artifact of the run it points at says the same.
// The superseded path (a newer commit exists) posts its error statuses right away in either phase and writes no verdict.
// Why approvals are bound by a RECEIPT: an approval must cover exactly the commit the owner reviewed. When a `labeled`
// event for an approval label (human-approved, test-change-approved) arrives from an allowed approver and the event's
// head is still the PR's head, the FIRST thing phase 1 does is post a commit status `pipeline-approval: <label>` on
// that head sha (the receipt). A label then counts for head H only if (a) it is present, (b) its latest `labeled`
// event was by an allowed approver, and either
//   - this very process posted the receipt in this run (a record kept in-process: the run's own artifact does not exist
//     yet, it is uploaded after phase 1) for that same approver, or
//   - (c) a receipt for it exists ON H, created by github-actions[bot] (a status posted with a human's or agent's token
//     does not count), from ANOTHER run, (d) not older than that latest `labeled` event (it was posted in response to
//     that very labeling), (e) whose target_url is a run of the pipeline-guards workflow, triggered by
//     pull_request_target, attempt 1, from a commit on the default branch, listing THIS PR at THIS head with the default
//     branch as base, and running when the receipt was posted (lib/guard-provenance.mjs), (f) whose description names
//     the label and the approver of the latest labeling, which happened inside that run's window, and (g) whose run
//     carries a verdict artifact naming that label and approver. (e) matters because pull_request_target reads the workflow
//     from the PR's BASE branch: an agent can push branch x with an edited workflow and open a PR into x on the same head
//     sha, and that run posts bot statuses on the shared head; (g) matters because such a run can point its status at a
//     genuine run of the same PR and head that is still in progress.
// An API-read receipt whose url is THIS run is never accepted: a spoofing run can point at the current run, and the
// current run's own receipt is trusted only through the in-process record. Statuses are per sha, so an approval on A can
// never cover a descendant B, however early B appeared elsewhere (another branch, a fork PR): the old "label is later than
// the earliest check suite of the head" rule was bypassable that way and is gone. A remove + re-add is a new labeled event,
// hence a new receipt. If the labeled run is cancelled before the receipt is posted, or before its artifact is uploaded, (a
// newer event for the same PR cancels it) the approval simply does not count and the label is removed with the note
// "re-apply the label" (fail closed). Residual: the code of the genuine job is the trust anchor - anything that can post a
// status as github-actions[bot] (for instance a workflow of a same-repo PR that declares statuses: write) could also post
// the two required statuses directly (the final gate then still demands the artifact, which only a genuine run uploads;
// a workflow with `actions: write` can only delete one, which fails closed); and an approver whose browser tab is stale
// can label a head they did not review (the receipt records the head the event named). Everything is re-derived from the
// GitHub API on every run, so it does not depend on which event woke the workflow, except that only the labeled event
// itself can create a receipt.
// The verdict lives in the statuses: exit 0 after publishing (even for "failure"), exit 1 only on an internal error
// (the workflow's `if: failure()` step then marks anything still pending as `error`).
// Who may approve: the logins in .claude/pipeline.yml ci.approvers; with no list, the repo owner of a USER-owned repo. An
// org-owned repo with no list fails closed (every approval ignored, reason org-repo-needs-ci.approvers), because an org
// name is never the login of whoever applies a label.
// Env: GH_TOKEN, REPO (owner/name), PR_NUMBER, EVENT_HEAD, BASE_SHA, RUN_URL, GITHUB_STEP_SUMMARY, OWNER_TYPE (optional:
// github.event.repository.owner.type, "User" | "Organization"; unset keeps the owner-login rule), and for receipts
// EVENT_ACTION / EVENT_LABEL / EVENT_SENDER (github.event.action, .label.name, .sender.login; empty for other events).
// Phase 1 also needs GITHUB_OUTPUT and PIPELINE_VERDICT_DIR or RUNNER_TEMP; phase 2 needs PIPELINE_VERDICT_DIR or RUNNER_TEMP.
// Vendored into projects by `pipeline vendor` (imports ./lib/* and ./ci-guard.mjs).
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARDSTOP_LABEL, INTEGRITY_LABEL, MAX_DESCRIPTION, clip, runCheck } from './ci-guard.mjs';
import { loadConfig } from './lib/config.mjs';
import { APPROVAL_LABELS, VERDICT_STATES, checkGuardVerdict, parseRunUrl, verdictArtifactName, withinRunWindow } from './lib/guard-provenance.mjs';
import { git, revParse } from './lib/git.mjs';
import { gh as defaultGh, GhError } from './lib/proc.mjs';

export const CONTEXTS = { integrity: 'Test integrity', hardstops: 'Hard-stop scan' };
export const VERDICT_FILE = 'verdict.json';
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

// Where phase 1 leaves the verdict for the upload step and phase 2: PIPELINE_VERDICT_DIR, else $RUNNER_TEMP/pipeline-verdict.
export function verdictDir(env) {
  if (env.PIPELINE_VERDICT_DIR && String(env.PIPELINE_VERDICT_DIR).trim()) return String(env.PIPELINE_VERDICT_DIR).trim();
  if (env.RUNNER_TEMP && String(env.RUNNER_TEMP).trim()) return join(String(env.RUNNER_TEMP).trim(), 'pipeline-verdict');
  throw new Error('missing environment variable PIPELINE_VERDICT_DIR (or RUNNER_TEMP)');
}

// The gh plumbing both phases share.
function session({ env, cwd, deps }, { repo, pr, head, base, runUrl }) {
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
  // A newer commit exists: this run's verdict would describe the wrong code, and the run for the new head decides.
  const superseded = () => {
    for (const context of Object.values(CONTEXTS)) post('error', context, 'superseded by a newer commit');
    return { exitCode: 0, output: { ok: true, superseded: true, head, base } };
  };
  return { api, post, currentHead, superseded };
}

/**
 * Phase 1: the whole guard flow except publishing. Returns { exitCode: 0, output }; throws on an internal error.
 * deps (tests): gh (proc.gh shape), check (passed to ci-guard runCheck).
 */
export async function runOrchestrator({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const { repo, pr, head, base, action, label: eventLabel, sender, runUrl, owner, ownerType } = readEnv(env);
  const { api, post, currentHead, superseded } = session({ env, cwd, deps }, { repo, pr, head, base, runUrl });
  const listLabels = () => lines(api([`repos/${repo}/issues/${pr}/labels`, '--paginate', '--jq', '.[].name']));

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
  // anything is evaluated, so a later cancellation cannot leave a half-recorded approval (it leaves none). What this
  // process posted is kept here: this run's own artifact does not exist until phase 1 is over.
  let ownReceipt = null;
  if (action === 'labeled' && Object.hasOwn(APPROVAL_CHECK, eventLabel) && sender) {
    const policy = await approverPolicy();
    if (policy.allowed(sender.toLowerCase())) {
      // The run URL is the receipt's provenance: a receipt without one could never be verified, so it is not posted.
      if (!runUrl) throw new Error('RUN_URL is required to post an approval receipt');
      const reply = post('success', receiptContext(eventLabel), receiptDescription(eventLabel, sender));
      let at = null;
      try { at = JSON.parse(reply)?.created_at ?? null; } catch { /* the reply is only used for its timestamp */ }
      ownReceipt = { label: eventLabel, login: sender, at };
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
    const current = parseRunUrl(runUrl);
    const isCurrentRun = (url) => {
      const u = parseRunUrl(url);
      return Boolean(current && u && u.repo.toLowerCase() === current.repo.toLowerCase() && u.runId === current.runId);
    };
    // (c)-(g) A receipt read from the API belongs to ANOTHER run: that run is verified, bound to this PR/head/time, names this
    // label and the approver of the latest labeling (which happened while it was going, so it answers that very event), and
    // carries a verdict artifact that says so too. One that points at THIS run is refused whatever else it shows.
    const receiptOk = (r, label, latest) => {
      const note = (why) => { process.stderr.write(`ignoring receipt ${r.context} (${r.at}): ${why}\n`); return false; };
      if (isCurrentRun(r.url)) return note('it points at the current run, whose own receipt is only trusted from this process\'s record');
      const verdict = checkGuardVerdict({ read, repo, url: r.url, bind: { prNumber: pr, headSha: head, createdAt: r.at }, expect: { receipt: { label, login: latest.actor } }, cache: provenanceCache });
      if (!verdict.ok) return note(verdict.reason);
      if (String(r.description ?? '').toLowerCase() !== receiptDescription(label, latest.actor).toLowerCase()) return note('its description does not name this label and the approver of the latest labeling');
      if (!withinRunWindow(verdict.window, latest.at)) return note('the labeling happened outside the window of the run that posted it');
      return true;
    };
    // This process posted the receipt for exactly this label and the approver of the latest labeling (and, when GitHub told
    // us when, not before that labeling).
    const ownOk = (label, latest) => ownReceipt !== null && ownReceipt.label === label
      && ownReceipt.login.toLowerCase() === String(latest.actor ?? '').toLowerCase()
      && !(Number.isFinite(Date.parse(ownReceipt.at ?? '')) && Date.parse(ownReceipt.at) < Date.parse(latest.at));
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
      else if (!ownOk(label, latest) && !receipts.some((r) => r.context === receiptContext(label) && r.by === RECEIPT_CREATOR && Date.parse(r.at) >= Date.parse(latest.at) && receiptOk(r, label, latest))) reason = 'no-receipt';
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

  // 4. Re-read before recording the verdict: a push or a label change while we worked must not be recorded over.
  if (currentHead() !== head) return superseded();
  if (!sameSet(listLabels(), pass.labels)) pass = await evaluatePass();

  // 5. Record the verdict (phase 2 publishes it). The note for an ignored approval goes on the status of the check that
  // approval would have overridden.
  const noteFor = (check) => {
    const bad = pass.approvals.invalid.filter((a) => APPROVAL_CHECK[a.label] === check);
    return bad.length > 0 ? [...new Set(bad.map((a) => NOTES[a.reason]))].join('; ') : '';
  };
  const checks = {};
  for (const [check, context] of Object.entries(CONTEXTS)) {
    const r = pass.results[check];
    const state = r.exitCode === 0 ? 'success' : r.exitCode === 1 ? 'failure' : 'error';
    const note = noteFor(check);
    const description = note ? `${clip(r.description, MAX_DESCRIPTION - note.length - 2)}; ${note}` : r.description;
    checks[check] = { context, state, description: clip(description, MAX_DESCRIPTION) };
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

  if (!env.GITHUB_OUTPUT || !String(env.GITHUB_OUTPUT).trim()) throw new Error('missing environment variable GITHUB_OUTPUT');
  const receipt = ownReceipt ? { label: ownReceipt.label, login: ownReceipt.login } : null;
  const artifact = verdictArtifactName({ head, integrity: checks.integrity.state, hardstops: checks.hardstops.state, receipt });
  const dir = verdictDir(env);
  mkdirSync(dir, { recursive: true });
  const verdict = {
    version: 1,
    pr: Number(pr),
    head,
    base,
    checks: { integrity: { state: checks.integrity.state, description: checks.integrity.description }, hardstops: { state: checks.hardstops.state, description: checks.hardstops.description } },
    // Removed by phase 2, after the statuses: removing a label fires `unlabeled`, which starts (and cancels this) run.
    removeLabels: pass.approvals.invalid.map((a) => a.label),
    receipt,
  };
  writeFileSync(join(dir, VERDICT_FILE), `${JSON.stringify(verdict, null, 2)}\n`);
  appendFileSync(env.GITHUB_OUTPUT, `artifact=${artifact}\n`);

  return {
    exitCode: 0,
    output: {
      ok: Object.values(checks).every((c) => c.state === 'success'),
      head,
      base,
      artifact,
      results: checks,
      approvals: { valid: pass.approvals.valid, ignored: pass.approvals.invalid },
    },
  };
}

/**
 * Phase 2 (`--publish`): publish what phase 1 recorded, unless the PR head moved since. Returns { exitCode: 0, output };
 * throws on an internal error (a missing or malformed verdict file included: nothing is published then).
 */
export async function runPublish({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const { repo, pr, head, base, runUrl } = readEnv(env);
  const { api, post, currentHead, superseded } = session({ env, cwd, deps }, { repo, pr, head, base, runUrl });

  let verdict;
  try {
    verdict = JSON.parse(readFileSync(join(verdictDir(env), VERDICT_FILE), 'utf8'));
  } catch (err) {
    throw new Error(`no readable verdict from the evaluate step: ${err.message}`);
  }
  const shape = verdict?.version === 1 && String(verdict.pr) === pr && verdict.head === head && verdict.base === base
    && Object.keys(CONTEXTS).every((k) => VERDICT_STATES.includes(verdict.checks?.[k]?.state) && typeof verdict.checks[k].description === 'string')
    && Array.isArray(verdict.removeLabels) && verdict.removeLabels.every((l) => APPROVAL_LABELS.includes(l));
  if (!shape) throw new Error('the verdict file does not describe this PR and head');

  // A newer commit may have arrived while the artifact was uploaded: the run for the new head decides.
  if (currentHead() !== head) return superseded();

  const published = {};
  for (const [check, context] of Object.entries(CONTEXTS)) {
    const { state, description } = verdict.checks[check];
    post(state, context, description);
    published[check] = { context, state, description: clip(description, MAX_DESCRIPTION) };
  }

  // Last, and best effort: removing a label fires `unlabeled`, which starts (and cancels this) run, so the verdict
  // must already be on record. The next run sees the cleaned label set and reaches the same verdict.
  const removed = [];
  for (const label of verdict.removeLabels) {
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
      approvals: { removed },
    },
  };
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  try {
    const flags = argv.filter((a) => a !== '--publish');
    if (flags.length > 0) throw new Error(`unknown argument ${flags[0]}`);
    const r = argv.includes('--publish') ? await runPublish({ env }) : await runOrchestrator({ env });
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
