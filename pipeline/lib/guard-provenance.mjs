// Provenance of a commit status that claims to come from the pipeline-guards workflow.
//
// Why: `pull_request_target` runs the workflow file from the PR's BASE branch. An agent can push branch `x` with an edited
// pipeline-guards.yml, open a PR into `x` whose head is the same sha as the real PR, and that run posts success statuses
// and approval receipts as `github-actions[bot]` on the shared head. The creator login alone proves nothing, and neither
// does a target_url (whoever posts the status chooses it, so a spoofing run can point at ANY genuine run). A status only
// counts when its target_url is an Actions run of THIS repository that
//   * ran the workflow file `.github/workflows/pipeline-guards.yml` (any `@ref` suffix of the run's `path` is ignored),
//   * was triggered by `pull_request_target`,
//   * is attempt 1: a re-run (`gh run rerun`) can execute an OLDER guard revision (the workflow file of the old main tip)
//     and post a fresh success over a newer failure, so re-runs never count; push a commit, or close and reopen the PR,
//     to run the guards again,
//   * judged THIS head: the run's `head_sha` is the status's sha. For pull_request_target GitHub records the PR's HEAD
//     commit as the run's head_sha (and the PR's branch as head_branch), NOT the base-branch commit the workflow file was
//     read from (measured on EagleWatch, runs 37906872583 and 37907596859). (Until 2026-10-09 this check instead required
//     head_sha to be on the default branch, which no genuine run ever satisfies: every guard status was discarded.)
//   * is ABOUT this verdict and ONLY about PRs into the default branch: `pull_requests` lists this PR number at the
//     status's sha with base.ref = the default branch, and lists no PR into any other branch (an empty list is untrusted:
//     fork PRs and runs not tied to a PR cannot be bound). base.ref is what blocks a DOWNGRADE or an edited copy: a
//     pull_request_target run for a PR INTO main always runs main's tip at event time, and a run that also lists a PR
//     into a side branch with the same head could have been triggered by that PR (with that branch's workflow file).
//     RESIDUAL (no API closes it): GitHub fills `pull_requests` from the OPEN PRs matching the head when it is read, so
//     a side-branch PR closed before the gate reads the run is no longer listed. Closing that needs an agent able to
//     push an edited pipeline-guards.yml to a branch — which the guard-files hook forbids,
//   * names, in that same PR entry, a base.sha that is an ancestor of, or equal to, the default branch. base.sha can lag
//     (GitHub refreshes it lazily). A lagging sha is still a main commit, and base.ref pins the WORKFLOW FILE to main's
//     tip; the workflow checks the guard scripts out at the run's own commit (main's tip at event time), so a lagging
//     base.sha does not run older scripts,
//   * was running when the status was posted: created_at - 10s <= status.created_at <= updated_at + 10s. The lower bound
//     is the run's creation (the event time), not run_started_at: a queued run can start long after the labeling it answers.
// and, for the verdict itself (checkGuardVerdict), carries a VERDICT ARTIFACT only the genuine run can upload.
// Why the artifact (issue #3, closed here): everything above is data a spoofing run (a PR into a side branch whose copy
// of the workflow was edited, same head sha) can satisfy by pointing its status at a genuine run of the same PR and head
// that is still in progress, and the agent can open that window on demand (re-run, close/reopen, ready/draft). So the
// genuine run also uploads an artifact named `pipeline-verdict_v1_<head>_<integrity>_<hardstops>[_<label>_<login>]` (see
// verdictArtifactName) holding what it judged, and a status counts only if the artifact of the run it points at says the
// same: for a guard status that run's state for that check must be `success`; for a receipt the artifact must name the
// label and the approver of the latest labeling. A spoofing run cannot add an artifact to somebody else's run (an
// artifact belongs to the run whose runtime token uploaded it), so it can only point at a run whose own verdict is the
// one it claims. A run without an artifact (in progress, cancelled before the upload, deleted) fails closed.
// Anything unreadable fails closed. What remains: the code of the genuine job is the trust anchor, and a workflow with
// `actions: write` can DELETE an artifact (that only fails closed).
// Shared by the ci-guards-run orchestrator (receipts) and the final gate (guard statuses); vendored with them.
export const GUARD_WORKFLOW_PATH = '.github/workflows/pipeline-guards.yml';
export const TIME_SLACK_MS = 10_000;
// The two human approval labels (same values as ci-guard.mjs, which this shared lib cannot import).
export const APPROVAL_LABELS = Object.freeze(['human-approved', 'test-change-approved']);
// Which check of the verdict artifact backs which guard status context.
export const GUARD_CONTEXT_CHECKS = Object.freeze({ 'Test integrity': 'integrity', 'Hard-stop scan': 'hardstops' });
export const VERDICT_STATES = Object.freeze(['success', 'failure', 'error']);
export const ARTIFACT_PREFIX = 'pipeline-verdict_v1_';

const RUN_URL = /^https?:\/\/[^/]+\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/actions\/runs\/([1-9][0-9]{0,18})(?:[/?#].*)?$/;
const SHA = /^[0-9a-f]{40}$/;
const STATE = VERDICT_STATES.join('|');
const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?(?:\\[bot\\])?';
const LOGIN_RE = new RegExp(`^${LOGIN}$`);
// Artifact names cannot contain " : < > | * ? \ / or newlines: this format uses none of them.
const ARTIFACT_RE = new RegExp(`^${ARTIFACT_PREFIX}([0-9a-f]{40})_(${STATE})_(${STATE})(?:_(${APPROVAL_LABELS.join('|')})_(${LOGIN}))?$`);
const RUN_JQ = '{path: .path, event: .event, status: .status, head_sha: .head_sha, run_attempt: .run_attempt, created_at: .created_at, updated_at: .updated_at, '
  + 'pull_requests: [(.pull_requests // [])[] | {number: .number, head: {sha: .head.sha}, base: {ref: .base.ref, sha: .base.sha}}]}';

/** { repo, runId } from an Actions run URL, or null. */
export function parseRunUrl(url) {
  const m = RUN_URL.exec(String(url ?? '').trim());
  return m ? { repo: m[1], runId: m[2] } : null;
}

/** Is `at` (ISO time) inside the run's [createdAt, updatedAt] window, with slack? */
export function withinRunWindow(window, at) {
  const t = Date.parse(at ?? '');
  const [from, to] = [Date.parse(window?.createdAt ?? ''), Date.parse(window?.updatedAt ?? '')];
  if (![t, from, to].every(Number.isFinite)) return false;
  return t >= from - TIME_SLACK_MS && t <= to + TIME_SLACK_MS;
}

/**
 * The name of the verdict artifact: `pipeline-verdict_v1_<head40>_<integrity>_<hardstops>`, plus `_<label>_<login>` when
 * the run posted an approval receipt. integrity / hardstops are success|failure|error. Throws on a value outside the format.
 */
export function verdictArtifactName({ head, integrity, hardstops, receipt = null } = {}) {
  const h = String(head ?? '').toLowerCase();
  if (!SHA.test(h)) throw new Error(`verdict artifact: head is not a full commit sha: ${head}`);
  for (const [k, v] of [['integrity', integrity], ['hardstops', hardstops]]) {
    if (!VERDICT_STATES.includes(v)) throw new Error(`verdict artifact: ${k} state is not success|failure|error: ${v}`);
  }
  let name = `${ARTIFACT_PREFIX}${h}_${integrity}_${hardstops}`;
  if (receipt) {
    if (!APPROVAL_LABELS.includes(receipt.label)) throw new Error(`verdict artifact: not an approval label: ${receipt.label}`);
    if (!LOGIN_RE.test(String(receipt.login ?? ''))) throw new Error(`verdict artifact: not a GitHub login: ${receipt.login}`);
    name += `_${receipt.label}_${receipt.login}`;
  }
  return name;
}

/** The inverse of verdictArtifactName: { head, integrity, hardstops, receipt: { label, login } | null }, or null for any other name. */
export function parseVerdictArtifactName(name) {
  const m = ARTIFACT_RE.exec(String(name ?? ''));
  if (!m) return null;
  return { head: m[1], integrity: m[2], hardstops: m[3], receipt: m[4] ? { label: m[4], login: m[5] } : null };
}

/**
 * read(apiPath, jqFilter) -> stdout text; throws on any failure (a thrown error is a failed provenance check).
 * bind = { prNumber, headSha, createdAt }: what the status is about (PR, the sha it sits on, when it was posted); all
 * three are mandatory. Returns { ok: true, window: { createdAt, updatedAt } } or { ok: false, reason }.
 * `cache` (a Map) holds the definitive reads (run, default branch, ancestry) so a process reads each once; the
 * verdict itself is recomputed per status because the time binding depends on it. A run that has not COMPLETED is never
 * cached: its updated_at (the window's end) and its artifact list still move. A gate that polls while the guards run reads
 * the run before the job posts its status, so caching that read froze the window ~20s short and discarded the run's own
 * status for the rest of the gate (measured: EagleWatch #1426, run 37929234322, status 12:19:29Z vs a cached end of
 * 12:19:11Z). Returns { ok: true, window, completed } on success.
 * This is the run-level check only; a status that claims a VERDICT goes through checkGuardVerdict (adds the artifact).
 */
export function checkRunProvenance({ read, repo, url, bind = {}, cache = new Map() }) {
  const run = parseRunUrl(url);
  if (!run) return { ok: false, reason: 'target_url is not an Actions run URL' };
  if (run.repo.toLowerCase() !== String(repo).toLowerCase()) return { ok: false, reason: 'the run belongs to a different repository' };
  const prNumber = Number(bind.prNumber);
  const headSha = String(bind.headSha ?? '').toLowerCase();
  if (!Number.isInteger(prNumber) || prNumber < 1 || !SHA.test(headSha) || !Number.isFinite(Date.parse(bind.createdAt ?? ''))) {
    return { ok: false, reason: 'no PR number, head sha and creation time were supplied to bind the run to' };
  }
  try {
    const key = `run:${run.runId}`;
    let info = cache.get(key);
    if (!info) {
      info = JSON.parse(read(`repos/${repo}/actions/runs/${run.runId}`, RUN_JQ));
      if (info?.status === 'completed') cache.set(key, info);
    }
    const completed = info?.status === 'completed';

    const workflow = String(info?.path ?? '').split('@')[0];
    if (workflow !== GUARD_WORKFLOW_PATH) return { ok: false, reason: `the run is workflow ${workflow || '(unknown)'}, not ${GUARD_WORKFLOW_PATH}` };
    if (info.event !== 'pull_request_target') return { ok: false, reason: `the run was triggered by ${info.event}, not pull_request_target` };
    if (info.run_attempt !== 1) {
      return { ok: false, reason: `the run is attempt ${info.run_attempt ?? '(unknown)'}: re-runs never count (a re-run can execute an older guard revision); push a commit or close and reopen the PR to run the guards again` };
    }
    const runHead = String(info.head_sha ?? '').toLowerCase();
    if (!SHA.test(runHead)) return { ok: false, reason: 'the run has no head_sha' };
    if (runHead !== headSha) return { ok: false, reason: `the run judged ${runHead.slice(0, 7)}, not ${headSha.slice(0, 7)}` };

    if (!cache.has('default-branch')) cache.set('default-branch', read(`repos/${repo}`, '.default_branch').trim());
    const branch = cache.get('default-branch');
    if (!branch || /\s/.test(branch)) return { ok: false, reason: 'the default branch could not be read' };

    const prs = Array.isArray(info.pull_requests) ? info.pull_requests : [];
    if (prs.length === 0) return { ok: false, reason: 'the run lists no pull request (fork PR, or not tied to one), so it cannot be bound to this PR' };
    const bound = prs.find((p) => p?.number === prNumber && String(p?.head?.sha ?? '').toLowerCase() === headSha && p?.base?.ref === branch);
    if (!bound) return { ok: false, reason: `the run is not about PR #${prNumber} at ${headSha.slice(0, 7)} into ${branch}` };
    const elsewhere = prs.find((p) => p?.base?.ref !== branch);
    if (elsewhere) {
      return { ok: false, reason: `the run is also about PR #${elsewhere?.number ?? '?'} into ${elsewhere?.base?.ref ?? '(unknown)'}, which may have triggered it with that branch's workflow file` };
    }
    // The commit the workflow file was read from: the PR's base, never the run's head_sha (= the PR head; see the header).
    const sha = String(bound.base?.sha ?? '').toLowerCase();
    if (!SHA.test(sha)) return { ok: false, reason: `the run's PR #${prNumber} entry has no base sha` };
    const window = { createdAt: info.created_at, updatedAt: info.updated_at };
    if (!withinRunWindow(window, bind.createdAt)) return { ok: false, reason: `the status was posted at ${bind.createdAt}, outside the run's window (${window.createdAt} to ${window.updatedAt})` };

    const ckey = `compare:${sha}`;
    if (!cache.has(ckey)) cache.set(ckey, read(`repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`, '.status').trim());
    const status = cache.get(ckey);
    // The default branch is `ahead` of (or `identical` to) a commit that is on it; `diverged`/`behind` means it is not.
    if (status !== 'identical' && status !== 'ahead') return { ok: false, reason: `the workflow ran from ${sha.slice(0, 7)}, which is not on the default branch (${status || 'unknown'})` };
    return { ok: true, window, completed };
  } catch (err) {
    return { ok: false, reason: `the run could not be verified (${String(err?.message ?? err).split('\n')[0].slice(0, 100)})` };
  }
}

/**
 * The run must carry a verdict artifact for `headSha` that backs the claim in `expect`:
 *   { check: 'integrity' | 'hardstops' }   a guard status: the artifact's state for that check must be `success`
 *                                           (every verdict artifact of that head must agree);
 *   { receipt: { label, login } }          an approval receipt: the artifact must name that label and approver (login case-insensitive).
 * The run's artifact list is read once per run (cache) — but only when `final` (the run has completed): a running job
 * uploads its verdict at the end, so an early empty list must not stick. Unreadable or missing fails closed.
 */
export function checkVerdictArtifact({ read, repo, runId, headSha, expect, cache = new Map(), final = true }) {
  const head = String(headSha ?? '').toLowerCase();
  if (!SHA.test(head) || !/^[1-9][0-9]{0,18}$/.test(String(runId ?? ''))) return { ok: false, reason: 'no run id and head sha were supplied to find the verdict artifact of' };
  try {
    const key = `artifacts:${runId}`;
    let list = cache.get(key);
    if (list === undefined) {
      list = read(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, '.artifacts[].name');
      if (final) cache.set(key, list);
    }
    const verdicts = String(list).split('\n').map((l) => l.trim()).filter(Boolean)
      .map(parseVerdictArtifactName).filter((v) => v && v.head === head);
    if (verdicts.length === 0) return { ok: false, reason: `the run carries no verdict artifact for ${head.slice(0, 7)} (still running, cancelled before the upload, or deleted)` };
    if (Object.hasOwn(expect ?? {}, 'check') && ['integrity', 'hardstops'].includes(expect.check)) {
      const bad = verdicts.find((v) => v[expect.check] !== 'success');
      return bad
        ? { ok: false, reason: `the run's own verdict for ${expect.check} is ${bad[expect.check]}, not success` }
        : { ok: true };
    }
    if (expect?.receipt && APPROVAL_LABELS.includes(expect.receipt.label) && expect.receipt.login) {
      const want = String(expect.receipt.login).toLowerCase();
      return verdicts.some((v) => v.receipt?.label === expect.receipt.label && v.receipt.login.toLowerCase() === want)
        ? { ok: true }
        : { ok: false, reason: `the run's verdict artifact does not record ${expect.receipt.label} approved by ${expect.receipt.login}` };
    }
    return { ok: false, reason: 'no valid expectation was supplied for the verdict artifact' };
  } catch (err) {
    return { ok: false, reason: `the run's artifacts could not be read (${String(err?.message ?? err).split('\n')[0].slice(0, 100)})` };
  }
}

/**
 * Provenance AND verdict artifact: the one call for a status that claims a verdict (a guard status or a receipt of ANOTHER
 * run). `expect` is mandatory (see checkVerdictArtifact), so a caller cannot get the run-level check alone by omission.
 * Returns { ok: true, window } or { ok: false, reason }.
 */
export function checkGuardVerdict({ read, repo, url, bind = {}, expect, cache = new Map() }) {
  const run = checkRunProvenance({ read, repo, url, bind, cache });
  if (!run.ok) return run;
  const artifact = checkVerdictArtifact({ read, repo, runId: parseRunUrl(url).runId, headSha: bind.headSha, expect, cache, final: run.completed });
  return artifact.ok ? run : artifact;
}
