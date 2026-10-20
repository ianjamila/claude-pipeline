// Busy-main hand-off (cp #88): when main keeps moving, hand the owner a PR whose own head is fully proven, with an honest
// statement of what was and was not verified against the main they will actually merge into. Pure decisions and text here;
// `commands/handoff.mjs` gathers the facts. Everything fails closed: a fact that cannot be read is "not eligible", and a
// base CI used that cannot be proven is printed as `unknown`, never guessed.
import { clip, defuse, flat } from './render.mjs';

export const HANDOFF_MARKER = '<!-- claude-pipeline:handoff -->';
export const MIN_UPDATES = 2;
const SHA40 = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 12);

// The live gate may fail ONLY pr-open, and only because of the base moving: exactly one failed check, named pr-open, whose
// detail STARTS with `behind-base` and names no other pr-open problem after it (a wrong base branch is appended last).
function gateProblem(gate) {
  const failed = (gate?.checks ?? []).filter((c) => !c.ok);
  if (failed.length === 0) return 'the live gate is not behind base';
  const only = failed.length === 1 && failed[0].name === 'pr-open'
    && String(failed[0].detail ?? '').startsWith('behind-base') && !String(failed[0].detail).includes('; PR base is');
  return only ? null : `the live gate fails more than behind-base: ${failed.map((c) => c.name).join(', ')}`;
}

// -> { eligible, reasons }. `strict`: required_status_checks.strict (false = not required), null = could not be read.
// `mergeTreeOk` / `quickVerifyOk`: true | false | null (null = not run, which is never enough).
export function handoffEligibility({ updates, strict, gate, mergeTreeOk, quickVerifyOk } = {}) {
  const reasons = [];
  if (!(Number.isInteger(updates) && updates >= MIN_UPDATES)) reasons.push(`fewer than ${MIN_UPDATES} base updates`);
  if (strict !== false) reasons.push('branch protection requires up-to-date branches (or could not be read)');
  const g = gateProblem(gate);
  if (g) reasons.push(g);
  if (mergeTreeOk !== true) reasons.push(mergeTreeOk === false ? 'merge-tree conflicts with main' : 'merge-tree was not checked');
  if (quickVerifyOk !== true) reasons.push(quickVerifyOk === false ? 'quick verify failed on head merged with main' : 'quick verify did not run on head merged with main');
  return { eligible: reasons.length === 0, reasons };
}

const PRODUCTION = {
  session: (pr) => `production: with production.watch: session, nobody watches production or rolls back after a GitHub merge until you say \`ship resume ${pr}\` (observe-only, never rolls back)`,
  workflow: () => "production: the project's workflow posts the production result on this PR",
  none: () => 'production: no production environment',
};

const MAX_LISTED = 50;

// The PR comment. Commit subjects and file names come from other people's commits: defused (no markup, no mentions) and flat.
// `overlap`: the PR files main also changed over its whole range (the command computes it; commits are only the listed ones). Without
// it, it is derived from `commits` and `prFiles`. `totalCommits` > listed commits means some were left out, and the comment says so.
export function renderHandoffComment({ pr, head, baseTip, ciBase, commits = [], totalCommits = commits.length, overlap: knownOverlap, prFiles = [], ownerItems = [], productionWatch = 'none', itemsChanged = false }) {
  const mine = new Set(prFiles);
  const ciText = ciBase === 'unknown' || !SHA40.test(String(ciBase)) ? 'unknown (could not prove which base CI used)' : short(ciBase);
  const lines = [
    HANDOFF_MARKER, '',
    `### Hand-off: #${pr} is ready for you to merge in GitHub`, '',
    `- Head ${short(head)}; main is now at ${short(baseTip)}.`,
    `- Verified: full verify + review on head; CI on head merged with main@${ciText}; quick verify on head merged with main@${short(baseTip)}. NOT verified: full verify / CI on head merged with main@${short(baseTip)}.`,
  ];
  lines.push('- Main\'s commits since the verified base:');
  const shown = commits.slice(0, MAX_LISTED);
  for (const c of shown) {
    const files = (c.files ?? []).slice(0, 8).map((f) => defuse(flat(f))).join(', ');
    lines.push(`  - ${short(c.sha)} ${clip(defuse(flat(c.subject)), 120)}${files ? ` (${files}${(c.files ?? []).length > 8 ? ', …' : ''})` : ''}`);
  }
  const total = Math.max(totalCommits, commits.length);
  if (total > shown.length) lines.push(`  - … and ${total - shown.length} more; ${total - shown.length} of main's ${total} commits are not listed (the overlap line below still covers all of them)`);
  if (total === 0) lines.push('  - none');
  const overlap = knownOverlap ?? [...new Set(commits.flatMap((c) => c.files ?? []).filter((f) => mine.has(f)))];
  lines.push(overlap.length > 0
    ? `- Overlap: touches this PR's files: ${overlap.slice(0, 20).map((f) => defuse(flat(f))).join(', ')}${overlap.length > 20 ? ', …' : ''}`
    : "- Overlap: none of this PR's files");
  lines.push(ownerItems.length > 0
    ? `- Owner-merge items: ${ownerItems.map((i) => defuse(flat(i))).join('; ')}`
    : '- Owner-merge items: none');
  if (itemsChanged) lines.push('- The owner-merge items changed while the check ran; the list above is the final one.');
  lines.push(`- ${(PRODUCTION[productionWatch] ?? PRODUCTION.none)(pr)}`);
  lines.push('', 'Merge in GitHub only if you accept this; the pipeline will not merge.');
  return lines.join('\n');
}

// ---- the base CI tested --------------------------------------------------------------------------------------------

const PER_PAGE = 100;
const MAX_PAGES = 10;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every page of the PR-event runs for `head`; complete or it throws (the caller turns any throw into 'unknown').
function listRuns(gh, slug, head) {
  const runs = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = gh.api('GET', `repos/${slug}/actions/runs?head_sha=${head}&event=pull_request&per_page=${PER_PAGE}&page=${page}`);
    if (!isObject(body) || !Array.isArray(body.workflow_runs) || !Number.isInteger(body.total_count)) throw new Error('unexpected runs listing');
    if (total !== null && body.total_count !== total) throw new Error('the runs listing changed while it was read');
    total = body.total_count;
    runs.push(...body.workflow_runs);
    if (runs.length === total) return runs;
    if (runs.length > total || body.workflow_runs.length < PER_PAGE) throw new Error('incomplete runs listing');
  }
  throw new Error('too many pages');
}

// The base GitHub used when CI ran on `head`: `pull_request` checks run on the PR's MERGE ref, whose commit has the parents
// [head, the base tip of that moment] (`ci-proof.mjs` documents the same fact). NOT today's potentialMergeCommit: it moves with
// main. Completed runs bound to this PR only; all usable runs must agree, else 'unknown'.
export function ciTestedBase({ gh, pr, head }) {
  try {
    const slug = gh.repo().slug;
    const wanted = `refs/pull/${pr}/merge`;
    const bases = new Set();
    for (const run of listRuns(gh, slug, head)) {
      if (!isObject(run) || String(run.head_sha ?? '').toLowerCase() !== head || run.event !== 'pull_request' || run.status !== 'completed') continue;
      if (run.repository?.full_name !== slug) continue;
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
      if (prs.length !== 1 || prs[0]?.number !== pr) continue;
      const refs = (Array.isArray(run.referenced_workflows) ? run.referenced_workflows : []).filter((w) => isObject(w) && w.ref === wanted && SHA40.test(String(w.sha)));
      if (new Set(refs.map((w) => w.sha)).size !== 1) continue;
      const parents = (gh.api('GET', `repos/${slug}/git/commits/${refs[0].sha}`)?.parents ?? []).map((p) => p?.sha);
      if (parents.length !== 2 || parents[0] !== head || !SHA40.test(String(parents[1]))) continue;
      bases.add(parents[1]);
    }
    return bases.size === 1 ? [...bases][0] : 'unknown';
  } catch {
    return 'unknown';
  }
}
