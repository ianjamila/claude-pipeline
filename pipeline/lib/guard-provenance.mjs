// Provenance of a commit status that claims to come from the pipeline-guards workflow.
//
// Why: `pull_request_target` runs the workflow file from the PR's BASE branch. An agent can push branch `x` with an edited
// pipeline-guards.yml, open a PR into `x` whose head is the same sha as the real PR, and that run posts success statuses
// and approval receipts as `github-actions[bot]` on the shared head. The creator login alone proves nothing, and neither
// does a target_url (whoever posts the status chooses it, so a spoofing run can point at ANY genuine run). A status only
// counts when its target_url is an Actions run of THIS repository that
//   * ran the workflow file `.github/workflows/pipeline-guards.yml` (any `@ref` suffix of the run's `path` is ignored),
//   * was triggered by `pull_request_target`,
//   * ran from a commit (`head_sha` = the base-branch tip the workflow file was read from) that is an ancestor of, or
//     equal to, the default branch,
//   * is ABOUT this verdict: `pull_requests` lists this PR number at the status's sha with base.ref = the default
//     branch (an empty list is untrusted: fork PRs and runs not tied to a PR cannot be bound). base.ref is what blocks a
//     DOWNGRADE: a side branch cut from an old main commit passes "ancestor of main" while running an old, weaker guard,
//     but a pull_request_target run for a PR INTO main always runs main's tip at event time, and
//   * was running when the status was posted: run_started_at - 10s <= status.created_at <= updated_at + 10s.
// Anything unreadable fails closed. Residual race (issue #3, a verdict artifact bound to the run): a spoofing run from a
// side base branch can still post, WHILE a genuine run for the same PR and head is in progress, a status pointing at
// that genuine run, because nothing ties a status to the run that wrote it except the run's own URL. Closing it needs
// the run to publish a verdict the gate can verify; that design is not part of this change.
// Shared by the ci-guards-run orchestrator (receipts) and the final gate (guard statuses); vendored with them.
export const GUARD_WORKFLOW_PATH = '.github/workflows/pipeline-guards.yml';
export const TIME_SLACK_MS = 10_000;

const RUN_URL = /^https?:\/\/[^/]+\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/actions\/runs\/([1-9][0-9]{0,18})(?:[/?#].*)?$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_JQ = '{path: .path, event: .event, head_sha: .head_sha, run_started_at: (.run_started_at // .created_at), updated_at: .updated_at, '
  + 'pull_requests: [(.pull_requests // [])[] | {number: .number, head: {sha: .head.sha}, base: {ref: .base.ref}}]}';

/** { repo, runId } from an Actions run URL, or null. */
export function parseRunUrl(url) {
  const m = RUN_URL.exec(String(url ?? '').trim());
  return m ? { repo: m[1], runId: m[2] } : null;
}

/** Is `at` (ISO time) inside the run's [run_started_at, updated_at] window, with slack? */
export function withinRunWindow(window, at) {
  const t = Date.parse(at ?? '');
  const [from, to] = [Date.parse(window?.startedAt ?? ''), Date.parse(window?.updatedAt ?? '')];
  if (![t, from, to].every(Number.isFinite)) return false;
  return t >= from - TIME_SLACK_MS && t <= to + TIME_SLACK_MS;
}

/**
 * read(apiPath, jqFilter) -> stdout text; throws on any failure (a thrown error is a failed provenance check).
 * bind = { prNumber, headSha, createdAt }: what the status is about (PR, the sha it sits on, when it was posted); all
 * three are mandatory. Returns { ok: true, window: { startedAt, updatedAt } } or { ok: false, reason }.
 * `cache` (a Map) holds the definitive reads (run, default branch, ancestry) so a process reads each once; the
 * verdict itself is recomputed per status because the time binding depends on it.
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
    if (!cache.has(key)) cache.set(key, JSON.parse(read(`repos/${repo}/actions/runs/${run.runId}`, RUN_JQ)));
    const info = cache.get(key);

    const workflow = String(info?.path ?? '').split('@')[0];
    if (workflow !== GUARD_WORKFLOW_PATH) return { ok: false, reason: `the run is workflow ${workflow || '(unknown)'}, not ${GUARD_WORKFLOW_PATH}` };
    if (info.event !== 'pull_request_target') return { ok: false, reason: `the run was triggered by ${info.event}, not pull_request_target` };
    const sha = String(info.head_sha ?? '').toLowerCase();
    if (!SHA.test(sha)) return { ok: false, reason: 'the run has no head_sha' };

    if (!cache.has('default-branch')) cache.set('default-branch', read(`repos/${repo}`, '.default_branch').trim());
    const branch = cache.get('default-branch');
    if (!branch || /\s/.test(branch)) return { ok: false, reason: 'the default branch could not be read' };

    const prs = Array.isArray(info.pull_requests) ? info.pull_requests : [];
    if (prs.length === 0) return { ok: false, reason: 'the run lists no pull request (fork PR, or not tied to one), so it cannot be bound to this PR' };
    if (!prs.some((p) => p?.number === prNumber && String(p?.head?.sha ?? '').toLowerCase() === headSha && p?.base?.ref === branch)) {
      return { ok: false, reason: `the run is not about PR #${prNumber} at ${headSha.slice(0, 7)} into ${branch}` };
    }
    const window = { startedAt: info.run_started_at, updatedAt: info.updated_at };
    if (!withinRunWindow(window, bind.createdAt)) return { ok: false, reason: `the status was posted at ${bind.createdAt}, outside the run's window (${window.startedAt} to ${window.updatedAt})` };

    const ckey = `compare:${sha}`;
    if (!cache.has(ckey)) cache.set(ckey, read(`repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`, '.status').trim());
    const status = cache.get(ckey);
    // The default branch is `ahead` of (or `identical` to) a commit that is on it; `diverged`/`behind` means it is not.
    if (status !== 'identical' && status !== 'ahead') return { ok: false, reason: `the workflow ran from ${sha.slice(0, 7)}, which is not on the default branch (${status || 'unknown'})` };
    return { ok: true, window };
  } catch (err) {
    return { ok: false, reason: `the run could not be verified (${String(err?.message ?? err).split('\n')[0].slice(0, 100)})` };
  }
}
