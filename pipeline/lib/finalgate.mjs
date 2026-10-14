// The final gate and merge helpers: the last line of defence before an agent merges to production.
// `evaluateGate` proves that THIS exact PR head was fully verified, cross-model reviewed, CI-green and
// preview-smoked; `pipeline merge` then refuses anything the gate file does not vouch for. Everything fails
// closed: a check that cannot be evaluated is a failed check, never a skipped one, and a gate that errors out
// leaves no final-gate.json behind (the command deletes the old one first), so stale evidence can never merge.
//
// The evidence is bound to the head in three independent ways: git.head (the report is for this commit),
// git.tree (nothing changed in the working tree since verify ran) and contentHash (the review covered exactly
// this patch). Each one defeats a different mistake, so none is redundant.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gh as ghRun } from './proc.mjs';
import { checkGuardVerdict, GUARD_CONTEXT_CHECKS } from './guard-provenance.mjs';
import { GUARD_CHECKS } from './config.mjs';
import { blockingHits, collectHardStops, ownerMergeHits } from './hardstops.mjs';
import { checkIntegrity } from './integrity.mjs';
import { runPreflight } from './preflight.mjs';
import { findDeployment } from './deploy.mjs';
import { toPosix } from './paths.mjs';
import { loadState } from './state.mjs';
import { parseYaml } from './yaml.mjs';
import { ownerRuledItems, reviewValidFor } from './triage.mjs';
import { skipOf } from './verify-steps.mjs';
import { commitTime, diffFiles, headSha, mergeBase, revParse, reviewBaseRef, reviewContentHash, treeFingerprint } from './git.mjs';

export const GATE_FILE = 'final-gate.json';
export const BLOCKING_LABELS = Object.freeze(['needs-human', 'awaiting-review', 'pipeline-blocked']);
// A gate older than this is evidence about a world that may be gone (base moved, a pause issue opened).
export const GATE_MAX_AGE_MS = 30 * 60_000;
export const PR_FIELDS = Object.freeze(['state', 'headRefOid', 'baseRefName', 'isDraft', 'labels', 'mergeable', 'mergeStateStatus']);

// What a gate must contain: exactly these checks (plus `preview` when config.preview is set), each once and passing.
// `merge` refuses a gate file that lacks any of them, so a hand-written or truncated file cannot vouch for a merge.
export const CANONICAL_CHECKS = Object.freeze(['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'review', 'ci']);
export const expectedCheckNames = (previewConfigured) => (previewConfigured ? [...CANONICAL_CHECKS, 'preview'] : [...CANONICAL_CHECKS]);

// `gh pr view` computes `mergeable` lazily: UNKNOWN right after a push. Re-read this many times, this far apart.
export const MERGEABLE_RETRIES = 3;
export const MERGEABLE_PAUSE_MS = 2000;
const MERGE_SHA_RETRIES = 3;
// Docs-only is deliberately narrow: markdown anywhere (not .mdx, which can hold executable JSX), text/reStructuredText/AsciiDoc
// under the root docs/ directory, and the LICENSE / CHANGELOG files. A .txt anywhere else (requirements.txt, CMakeLists.txt, a
// prompt file) is code.
const MARKDOWN = /\.(?:md|markdown)$/i;
const DOCS_DIR_TEXT = /\.(?:md|markdown|txt|rst|adoc)$/i;
const DOC_NAMES = /^(?:license|licence|changelog)(?:\.(?:md|markdown|txt))?$/i;
// Agent instruction files steer what an agent does next, so they are code wherever they sit (docs/ included).
const AGENT_INSTRUCTION_FILES = new Set(['claude.md', 'agents.md', 'gemini.md', '.cursorrules', 'copilot-instructions.md']);
// Instructions, hooks, workflows and the pipeline itself: text files here change what agents or CI do, so they are code.
const NEVER_DOCS_DIRS = new Set(['.claude', '.github', '.githooks', 'skills', 'agents', 'pipeline', 'scripts']);
const FULL_SHA = /^[0-9a-f]{40}$/;
const TAIL_LINES = 30;
const MAX_LINE = 400;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 8) : String(sha));
// ownerMerge (owner_approval: chat): how many items of this check the owner merges in chat; only present when > 0.
const check = (name, ok, detail, ownerMerge = 0) => ({ name, ok: ok === true, detail, ...(ownerMerge > 0 ? { ownerMerge } : {}) });

// ---- review-dir files ---------------------------------------------------------------------------

export const reviewFile = (root, name) => join(root, '.review', name);

// tmp + rename: a reader (merge, final-gate) sees the old file or the whole new one, never half of it.
export function writeReviewJson(root, name, value) {
  const file = reviewFile(root, name);
  mkdirSync(join(root, '.review'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// null when the file is absent or unparseable: for evidence, "unreadable" and "missing" both mean "not proven".
export function readReviewJson(root, name) {
  try {
    const parsed = JSON.parse(readFileSync(reviewFile(root, name), 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeReviewFile(root, name) {
  rmSync(reviewFile(root, name), { force: true });
}

// Last `n` lines of command output: colours stripped, absurdly long lines (minified bundles) clipped.
export function tailLines(text, n = TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}...` : l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

// node's parseArgs refuses an option value that starts with a dash (`--line "- 2026-10-01 ..."`: markdown bullets do), so
// fold `--name value` into `--name=value` for the named options before parsing. Only the token right after the name is taken.
export function inlineOptionValues(argv, names) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (names.includes(a) && i + 1 < argv.length) {
      out.push(`${a}=${argv[i + 1]}`);
      i += 1;
    } else {
      out.push(a);
    }
  }
  return out;
}

// ---- classifiers --------------------------------------------------------------------------------

export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
}

// Case-insensitive on purpose: GitHub treats label names that way, and a blocker must not be dodged by a case change.
export function blockingLabelsOf(labels) {
  return labelNames(labels).filter((n) => BLOCKING_LABELS.includes(n.toLowerCase()));
}

const pathsOf = (f) => [f.oldPath, f.newPath, f.path].filter((p) => typeof p === 'string');

function isDocPath(p) {
  const parts = toPosix(p).replace(/^\.\//, '').split('/');
  const name = parts.at(-1);
  if (AGENT_INSTRUCTION_FILES.has(name.toLowerCase()) || parts.slice(0, -1).some((d) => NEVER_DOCS_DIRS.has(d.toLowerCase()))) return false;
  if (MARKDOWN.test(name) || DOC_NAMES.test(name)) return true;
  return parts.length > 1 && parts[0].toLowerCase() === 'docs' && DOCS_DIR_TEXT.test(name);
}

// Every changed file is a non-binary doc (see isDocPath) outside the instruction/hook/workflow/pipeline directories (a
// rename counts by BOTH its paths: moving code into docs/ is not docs-only). Living under docs/ is not enough: a
// script or an image there is not documentation. Only this rule lets a `skipping` CI check pass.
export function isDocsOnly(files) {
  return Array.isArray(files) && files.length > 0
    && files.every((f) => isObject(f) && f.binary !== true && pathsOf(f).length > 0 && pathsOf(f).every(isDocPath));
}

// The diff touches only the agent log, and only by adding lines to it (no edits or deletions of history).
export function isLogOnly(files, agentLog) {
  if (!Array.isArray(files) || files.length === 0 || typeof agentLog !== 'string') return false;
  const log = toPosix(agentLog).replace(/^\.\//, '');
  // A record without `removed` removes nothing; any other shape of it is unexpected, and unexpected means not log-only.
  const noRemovals = (f) => f.removed === undefined || (Array.isArray(f.removed) && f.removed.length === 0);
  return files.every((f) => isObject(f) && f.path === log && (f.status === 'A' || f.status === 'M') && f.binary !== true && noRemovals(f));
}

// `gh pr view` right after a push often says mergeable UNKNOWN; re-read a few times before judging it.
export async function readPrSettled({ gh, pr, fields, sleep = defaultSleep, pauseMs = MERGEABLE_PAUSE_MS, retries = MERGEABLE_RETRIES }) {
  let view = gh.prView(pr, fields);
  for (let i = 0; i < retries && view?.mergeable === 'UNKNOWN'; i++) {
    await sleep(pauseMs);
    view = gh.prView(pr, fields);
  }
  return view;
}

// Test hook: PIPELINE_MERGEABLE_PAUSE_MS can only SHORTEN the pause between UNKNOWN re-reads, never stretch it.
export function mergeablePause(env = {}) {
  const n = Number(env?.PIPELINE_MERGEABLE_PAUSE_MS);
  return Number.isInteger(n) && n >= 0 && n < MERGEABLE_PAUSE_MS ? n : MERGEABLE_PAUSE_MS;
}

// Did the owner write `ci.required_checks: []` (as opposed to never mentioning it, which also reads as [])?
function ciExplicitlyEmpty(root) {
  try {
    const parsed = parseYaml(readFileSync(join(root, '.claude', 'pipeline.yml'), 'utf8'));
    const list = parsed?.ci?.required_checks;
    return Array.isArray(list) && list.length === 0;
  } catch {
    return false;
  }
}

// ---- refs, hashes -------------------------------------------------------------------------------

// `origin/<default>` when the remote ref exists (the PR's real base), else the local default branch.
export const baseRefFor = (root, config) => reviewBaseRef(config.default_branch, { cwd: root });

// The review's content hash for HEAD: the patch against the merge-base, minus the agent log the pipeline appends to.
// Literally the review loop's hash: both call git.mjs#reviewContentHash.
export const localContentHash = (root, config) =>
  reviewContentHash({ branch: config.default_branch, agentLog: config.agent_log }, { cwd: root });

function lazyDiff(root, config) {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      const o = { cwd: root };
      const mb = mergeBase(baseRefFor(root, config), 'HEAD', o);
      cached = { ok: true, mb, files: diffFiles(mb, 'HEAD', o) };
    } catch (err) {
      cached = { ok: false, error: String(err?.message ?? err) };
    }
    return cached;
  };
}

// ---- the checks ---------------------------------------------------------------------------------

function prOpenCheck({ info, head, config, behind = null }) {
  const problems = [];
  if (info.state !== 'OPEN') problems.push(`PR state is ${info.state}`);
  if (info.isDraft !== false) problems.push('PR is a draft');
  if (info.mergeable === 'CONFLICTING') problems.push('PR has merge conflicts');
  else if (info.mergeable !== 'MERGEABLE') problems.push(`PR mergeable state is ${JSON.stringify(info.mergeable)}, not MERGEABLE (GitHub has not finished computing it, or it did not say)`);
  if (info.headRefOid !== head) problems.push(`PR head ${short(info.headRefOid)} is not the local HEAD ${short(head)}`);
  // Branch protection is not strict (spec 6.6), so GitHub will merge a PR that is behind its base: that would land code on a
  // base nobody verified it against. The branch must be updated (and re-verified) first.
  if (behind) problems.push(`behind-base: ${behind}; update the branch from ${config.default_branch} and re-verify before merging`);
  // The hard-stop, integrity and review diffs are taken against the default branch; any other base would be judged on the wrong diff.
  if (info.baseRefName !== config.default_branch) problems.push(`PR base is ${JSON.stringify(info.baseRefName)}, not ${config.default_branch}`);
  return problems.length ? check('pr-open', false, problems.join('; ')) : check('pr-open', true, `open at ${short(head)}`);
}

// Why this PR is behind its base, or null: GitHub says BEHIND, or the base tip is not an ancestor of HEAD (the merge base
// with the base ref is not the base ref's own commit). The local ref can be stale, which only makes this check lenient;
// GitHub's own mergeStateStatus is the authority.
function behindBase({ info, diff, root, config }) {
  if (info?.mergeStateStatus === 'BEHIND') return 'GitHub reports the PR is BEHIND its base (mergeStateStatus BEHIND)';
  const d = diff();
  if (!d.ok) return null; // the checks that need the diff report it themselves
  try {
    const ref = baseRefFor(root, config);
    const tip = revParse(`${ref}^{commit}`, { cwd: root });
    if (tip !== d.mb) return `the base (${ref} at ${short(tip)}) is not an ancestor of HEAD; the branch forked from ${short(d.mb)}`;
  } catch { /* an unreadable ref was already reported by the diff */ }
  return null;
}

export const validLabels = (labels) => Array.isArray(labels) && labels.every((l) => isObject(l) && typeof l.name === 'string');

// A reply that does not carry a proper label list is not "no blocking labels": it is no answer.
export function labelsCheck(info) {
  if (!validLabels(info?.labels)) return check('labels', false, 'PR labels could not be read (labels is missing or malformed)');
  const blocking = blockingLabelsOf(info.labels);
  return blocking.length ? check('labels', false, `blocking label(s): ${blocking.join(', ')}`) : check('labels', true, 'no blocking labels');
}

async function preflightCheck({ root, env, gh }) {
  const report = await runPreflight({ cwd: root, env, gh });
  if (report.canMerge) return check('preflight', true, 'pipeline may merge');
  return check('preflight', false, report.reasons.length ? report.reasons.join('; ') : 'preflight says the pipeline may not merge');
}

const SKIP_REASON_SHOWN = 80;
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\u2026` : text);

function verifyReportCheck({ root, config, head, tree, o }) {
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(root, config.verify.report), 'utf8'));
  } catch (err) {
    return check('verify-report', false, `no usable verify report at ${config.verify.report}: ${err.code ?? err.message}`);
  }
  if (!isObject(report)) return check('verify-report', false, 'verify report is not a JSON object');
  const problems = [];
  if (report.ok !== true) problems.push('report.ok is not true');
  if (report.mode !== 'full') problems.push(`mode is ${JSON.stringify(report.mode)}, not "full"`);
  // The verify template marks `--only` runs with mode "partial" and does not write a `partial` field at all, so absence is
  // fine for a full report; but when the field is there it must be exactly false (true, "false", null, 0 are all refusals).
  if (Object.hasOwn(report, 'partial') && report.partial !== false) problems.push(`report is partial (partial=${JSON.stringify(report.partial)})`);

  const steps = Array.isArray(report.steps) ? report.steps : null;
  // verify.expected_steps in pipeline.yml is the owner's list: a report that declares a shorter expectedSteps for itself
  // (and runs only those) must not be able to dodge a step. Without it, the report's own list is all there is.
  const pinned = Array.isArray(config.verify.expected_steps) ? config.verify.expected_steps : null;
  const expected = pinned ?? (Array.isArray(report.expectedSteps) ? report.expectedSteps : null);
  const source = pinned ? 'verify.expected_steps' : 'expectedSteps';
  if (!expected || expected.length === 0) problems.push('report has no expectedSteps');
  if (!steps || steps.length === 0) problems.push('report has no steps');
  if (steps && expected && JSON.stringify(steps.map((s) => s?.name)) !== JSON.stringify(expected)) {
    problems.push(`steps [${steps.map((s) => s?.name).join(', ')}] do not match ${source} [${expected.join(', ')}]`);
  }
  // A skipped step is accepted only when the owner listed it in verify.skippable_steps and it says why; anything else that
  // is not a plain pass (fail, not-run, an unknown status) is refused as before.
  const skippable = Array.isArray(config.verify.skippable_steps) ? config.verify.skippable_steps : [];
  const skips = (steps ?? []).map(skipOf).filter(Boolean);
  const notPassed = (steps ?? []).filter((s) => s?.status !== 'pass' && skipOf(s) === null).map((s) => `${s?.name}=${s?.status}`);
  if (notPassed.length) problems.push(`steps not passing: ${notPassed.join(', ')}`);
  for (const k of skips) {
    if (!skippable.includes(k.name)) problems.push(`step ${k.name} was skipped; list it in verify.skippable_steps to allow that`);
    else if (k.reason === '') problems.push(`step ${k.name} was skipped without a reason`);
  }

  const g = isObject(report.git) ? report.git : {};
  if (g.head !== head) problems.push(`report is for ${short(g.head)}, HEAD is ${short(head)}`);
  if (g.dirty !== false) problems.push('report was produced on a dirty tree');
  // `treeHash` is the spec's spelling of the same field; either must equal the tree as it is now.
  const reportedTree = g.tree ?? g.treeHash;
  if (typeof reportedTree !== 'string' || reportedTree === '' || reportedTree !== tree) problems.push('the working tree changed since verify ran');

  const finished = Date.parse(report.finishedAt);
  if (!Number.isFinite(finished)) problems.push('finishedAt is missing or not a date');
  else if (finished < commitTime(head, o)) problems.push('report finished before the HEAD commit was made');

  return problems.length ? check('verify-report', false, problems.join('; ')) : check('verify-report', true, `full verify passed at ${short(head)} (${steps.length} steps${skips.length ? `: ${steps.length - skips.length} ran, ${skips.length} skipped: ${skips.map((k) => `${k.name} \u2014 ${clip(k.reason, SKIP_REASON_SHOWN)}`).join('; ')}` : ''})`);
}

async function hardstopsCheck({ root, config, diff }) {
  const d = diff();
  if (!d.ok) return check('hardstops', false, `could not diff against the base: ${d.error}`);
  const hits = await collectHardStops({ base: d.mb, head: 'HEAD', cwd: root, config });
  if (hits.length === 0) return check('hardstops', true, 'no hard-stops');
  // Report-only (advisory) hits are listed, never failing: only blocking hits stop the merge.
  const blocking = blockingHits(hits);
  const chat = ownerMergeHits(hits).length;
  const advisoryCount = hits.length - blocking.length - chat;
  if (blocking.length === 0) {
    if (chat === 0) return check('hardstops', true, `no blocking hard-stops (${advisoryCount} report-only)`);
    // owner_approval: chat: nothing blocks, but the owner must say "merge" for these.
    return check('hardstops', true, `no blocking hard-stops (${chat} owner-merge, ${advisoryCount} report-only)`, chat);
  }
  const shown = blocking.slice(0, 5).map((h) => `${h.rule} ${h.file ?? ''}`.trim()).join('; ');
  const note = advisoryCount > 0 ? ` (+${advisoryCount} report-only)` : '';
  return check('hardstops', false, `${blocking.length} hard-stop hit(s): ${shown}${blocking.length > 5 ? '; ...' : ''}${note}`);
}

function integrityCheck({ config, diff }) {
  const d = diff();
  if (!d.ok) return check('integrity', false, `could not diff against the base: ${d.error}`);
  // No labels passed: the override label is deliberately not honoured at the gate.
  const r = checkIntegrity({ files: d.files, config, labels: [] });
  if (r.ok) {
    const chat = r.ownerMerge?.length ?? 0;
    return chat > 0 ? check('integrity', true, `${chat} owner-merge test-integrity violation(s)`, chat) : check('integrity', true, 'no test weakening');
  }
  const shown = r.violations.slice(0, 5).map((v) => `${v.rule ?? v.type ?? 'violation'} ${v.file ?? ''}`.trim()).join('; ');
  return check('integrity', false, `${r.violations.length} test-integrity violation(s): ${shown}`);
}

// How many owner-ruled items the review detail lists, and how much of each quote.
const OWNER_RULED_SHOWN = 5;
const OWNER_QUOTE_SHOWN = 100;

function reviewCheck({ root, config, pr, diff, hash, hashError }) {
  const d = diff();
  if (!d.ok) return check('review', false, `could not diff against the base: ${d.error}`);
  if (isLogOnly(d.files, config.agent_log)) return check('review', true, 'log-only');
  const state = loadState(root); // a corrupt state throws: caught by the caller as a failed check
  if (!state) return check('review', false, 'no review state at .review/state.json');
  if (!(Number.isInteger(state.pr) && state.pr > 0)) return check('review', false, `review state records no valid PR number (${JSON.stringify(state.pr)}), expected #${pr}`);
  if (state.pr !== pr) return check('review', false, `review state is for PR #${state.pr}, not #${pr}`);
  if (!hash) return check('review', false, `cannot compute the content hash: ${hashError}`);
  if (!reviewValidFor(state, hash)) {
    return check('review', false, `no clean review round covers the current content (${short(hash)}), or findings are unresolved`);
  }
  // owner_approval: chat: an item the owner ruled in chat (an original or a later round's cached copy) never clears the merge by
  // itself. It stays visible here and counts as ownerMerge, so the owner's "merge" for this head is still needed.
  const ruled = ownerRuledItems(state);
  if (ruled.length > 0) {
    const shown = ruled.slice(0, OWNER_RULED_SHOWN).map((i) => `${i.id} "${clip(String(i.final.ownerQuote).replace(/\s+/g, ' ').trim(), OWNER_QUOTE_SHOWN)}"`).join('; ');
    return check('review', true, `review valid for content ${short(hash)}; ${ruled.length} owner-ruled item(s), owner-merge: ${shown}${ruled.length > OWNER_RULED_SHOWN ? '; ...' : ''}`, ruled.length);
  }
  return check('review', true, `review valid for content ${short(hash)}`);
}

// CI evidence. Judged: the checks GitHub itself requires (`gh pr checks --required`), or every reported check when it
// requires none. On top of that every check NAMED in config.ci.required_checks must be reported and passing, so a
// required check that never ran (renamed, workflow deleted, path-filtered away) cannot be mistaken for a green PR.
// `skipping` only passes for a trusted docs-only diff. Nothing configured and nothing required by GitHub fails closed,
// unless the owner wrote `ci.required_checks: []` explicitly (then every reported check must pass).
function ciCheck({ gh, pr, head, diff, config, explicitEmpty }) {
  const named = config.ci?.required_checks ?? [];
  let requiredRows = [];
  try {
    const rows = gh.checks(pr, { required: true });
    requiredRows = Array.isArray(rows) ? rows : [];
  } catch {
    requiredRows = []; // gh says "no required checks reported" on stdout-less exit 1
  }
  if (named.length === 0 && requiredRows.length === 0 && !explicitEmpty) {
    return check('ci', false, 'no required checks are configured (ci.required_checks) and GitHub reports none as required: there is no CI evidence');
  }
  let allRows = null;
  const all = () => (allRows ??= gh.checks(pr));

  const source = requiredRows.length > 0 ? 'required' : 'all';
  const examined = requiredRows.length > 0 ? requiredRows : all();
  if (examined.length === 0) return check('ci', false, 'no CI checks reported');
  const d = diff();
  const docsOnly = d.ok && isDocsOnly(d.files);
  const passing = (r) => r?.bucket === 'pass' || (docsOnly && r?.bucket === 'skipping');

  const bad = examined.filter((r) => !passing(r));
  const missing = [];
  // Every row that satisfies ANY requirement source (what GitHub requires, what the config names, what is examined). A
  // guard row counts as satisfied however it got here, so each one needs provenance: GitHub may require only `ci` while the
  // config also names `Hard-stop scan`, and that row is then found in all(), not in requiredRows.
  const used = [...examined];
  for (const name of named) {
    let rows = requiredRows.filter((r) => r?.name === name);
    if (rows.length === 0) rows = all().filter((r) => r?.name === name);
    if (rows.length === 0) missing.push(name);
    used.push(...rows);
    for (const r of rows) if (!passing(r) && !bad.includes(r)) bad.push(r);
  }
  // A guard status is only believed when the pipeline-guards workflow from the default branch posted it, and that run's own
  // verdict artifact says success for it (guard-provenance). The row's link is not trusted (anyone posting a status picks
  // it): the latest status of that context on the head is read directly and bound to this PR, this head and its own
  // creation time.
  const guardNames = new Set();
  for (const r of used) {
    if (r && GUARD_CHECKS.includes(r.name) && passing(r)) guardNames.add(r.name);
  }
  const forged = [];
  const provenanceCache = new Map();
  for (const name of guardNames) {
    let verdict;
    try {
      const slug = gh.repo().slug;
      const read = (p, jq) => gh.apiText(p, jq);
      const latest = JSON.parse(read(`repos/${slug}/commits/${head}/statuses?per_page=100`,
        `[.[] | select(.context == "${name}")][0] | {state: .state, by: .creator.login, at: .created_at, url: .target_url}`));
      if (!latest || latest.state !== 'success') verdict = { ok: false, reason: 'its latest status is not a success' };
      else if (latest.by !== 'github-actions[bot]') verdict = { ok: false, reason: `posted by ${latest.by ?? 'an unknown creator'}, not github-actions[bot]` };
      else verdict = checkGuardVerdict({ read, repo: slug, url: latest.url, bind: { prNumber: pr, headSha: head, createdAt: latest.at }, expect: { check: GUARD_CONTEXT_CHECKS[name] }, cache: provenanceCache });
    } catch (err) {
      verdict = { ok: false, reason: String(err?.message ?? err).split('\n')[0] };
    }
    if (!verdict.ok) forged.push(`${name} (${verdict.reason})`);
  }
  const problems = [];
  if (forged.length) problems.push(`guard status not posted by the pipeline-guards workflow: ${forged.join('; ')}`);
  if (missing.length) problems.push(`required check(s) missing: ${missing.join(', ')}`);
  if (bad.length) problems.push(`${bad.length} ${source} check(s) not passing: ${bad.map((r) => `${r?.name}=${r?.bucket ?? r?.state}`).join(', ')}`);
  if (problems.length) return check('ci', false, problems.join('; '));
  return check('ci', true, `${examined.length} ${source} check(s) passing${named.length ? ` (all ${named.length} named in config present)` : ''}${docsOnly ? ' (docs-only: skipped checks accepted)' : ''}`);
}

// The smoke record is the agent's own claim (--sha and --url are arguments), so it is only believed when GitHub's
// deployments agree: a successful deployment of exactly this head in the configured environment, at the same origin the
// smoke ran against.
async function previewCheck({ root, head, config, gh }) {
  const smoke = readReviewJson(root, 'preview-smoke.json');
  if (!smoke) return check('preview', false, 'no preview smoke evidence at .review/preview-smoke.json');
  if (smoke.ok !== true) return check('preview', false, 'preview smoke did not pass');
  if (smoke.sha !== head) return check('preview', false, `preview smoke is for ${short(smoke.sha)}, HEAD is ${short(head)}`);
  const originOf = (u) => {
    try {
      const url = new URL(u);
      return /^https?:$/.test(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  };
  const smokeOrigin = originOf(smoke.url);
  if (!smokeOrigin) return check('preview', false, 'preview smoke record has no usable url (an http(s) URL is required)');
  const environment = config.preview.environment;
  const found = await findDeployment({ gh, sha: head, environment, timeoutMs: 0 });
  if (found.state !== 'success') return check('preview', false, `no successful ${environment} deployment of ${short(head)} on GitHub (${found.state})`);
  if (found.sha !== head) return check('preview', false, `the ${environment} deployment is for ${short(found.sha)}, not HEAD ${short(head)}`);
  const deployedOrigin = originOf(found.url);
  if (deployedOrigin !== smokeOrigin) {
    return check('preview', false, `preview smoke ran against ${smokeOrigin}, but the ${environment} deployment of ${short(head)} is at ${deployedOrigin ?? 'an unknown URL'} (origin mismatch)`);
  }
  return check('preview', true, `preview smoke passed at ${short(head)} against the GitHub ${environment} deployment ${deployedOrigin}`);
}

// A check that throws is a failed check: it must show up in the report instead of aborting the whole gate.
async function safely(name, fn) {
  try {
    return await fn();
  } catch (err) {
    return check(name, false, `could not evaluate: ${String(err?.message ?? err)}`);
  }
}

// ---- the gate -----------------------------------------------------------------------------------

// Runs every check (no short-circuit, so one run reports every problem). A gh failure on the PR lookup itself throws:
// the caller maps it to exit 3, because without the PR there is nothing to judge.
export async function evaluateGate({ root, config, pr, gh, env, sleep = defaultSleep }) {
  const o = { cwd: root };
  const head = headSha(o);
  const info = await readPrSettled({ gh, pr, fields: [...PR_FIELDS], sleep, pauseMs: mergeablePause(env) });
  const diff = lazyDiff(root, config);

  let hash = '';
  let hashError = null;
  try {
    hash = localContentHash(root, config);
  } catch (err) {
    hashError = String(err?.message ?? err);
  }
  let tree = '';
  try {
    tree = treeFingerprint(o);
  } catch { /* the verify-report check fails on an empty tree */ }
  let repo = null;
  try {
    repo = gh.repo().slug;
  } catch { /* recorded as null */ }

  const checks = [
    await safely('pr-open', () => prOpenCheck({ info, head, config, behind: behindBase({ info, diff, root, config }) })),
    await safely('labels', () => labelsCheck(info)),
    await safely('preflight', () => preflightCheck({ root, env, gh })),
    await safely('verify-report', () => verifyReportCheck({ root, config, head, tree, o })),
    await safely('hardstops', () => hardstopsCheck({ root, config, diff })),
    await safely('integrity', () => integrityCheck({ config, diff })),
    await safely('review', () => reviewCheck({ root, config, pr, diff, hash, hashError })),
    await safely('ci', () => ciCheck({ gh, pr, head, diff, config, explicitEmpty: ciExplicitlyEmpty(root) })),
  ];
  if (config.preview !== null) checks.push(await safely('preview', () => previewCheck({ root, head, config, gh })));

  const d = diff();
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    repo,
    pr,
    base: info.baseRefName ?? null,
    mergeBase: d.ok ? d.mb : null,
    head,
    tree,
    contentHash: hash,
    checks,
    // owner_approval: chat: items the owner merges in chat (0 = none, merge as usual). The ship skill reads this.
    ownerMerge: checks.reduce((n, c) => n + (c.ownerMerge ?? 0), 0),
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    at: new Date().toISOString(),
  };
}

// ---- merge --------------------------------------------------------------------------------------

// Why a gate file does not vouch for merging `pr` at `head` right now. Empty list = it does.
export function gateRefusals({ gate, pr, head, prHead, hash, repo, previewConfigured = false, now = Date.now() }) {
  if (!isObject(gate)) return ['no final-gate.json (or it is unreadable)'];
  const out = [];
  if (gate.ok !== true) out.push('the gate did not pass');
  if (!Array.isArray(gate.checks) || gate.checks.length === 0 || !gate.checks.every((c) => c?.ok === true)) out.push('the gate has failing or missing checks');
  const names = Array.isArray(gate.checks) ? gate.checks.map((c) => (isObject(c) ? c.name : undefined)) : [];
  const expected = expectedCheckNames(previewConfigured === true);
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) out.push(`the gate is missing canonical check(s): ${missing.join(', ')}`);
  const unexpected = [...new Set(names.filter((n) => typeof n === 'string' && !expected.includes(n)))];
  if (unexpected.length) out.push(`the gate carries unexpected check(s): ${unexpected.join(', ')}`);
  const repeated = expected.filter((n) => names.filter((x) => x === n).length > 1);
  if (repeated.length) out.push(`the gate lists check(s) more than once: ${repeated.join(', ')}`);
  if (typeof gate.repo !== 'string' || gate.repo === '') out.push('the gate records no repo (run final-gate again)');
  else if (typeof repo !== 'string' || repo === '') out.push('could not determine the repo to compare the gate against');
  else if (gate.repo !== repo) out.push(`the gate is for ${gate.repo}, not ${repo}`);
  if (gate.pr !== pr) out.push(`the gate is for PR #${gate.pr}, not #${pr}`);
  if (typeof gate.head !== 'string' || !FULL_SHA.test(gate.head)) out.push('the gate records no valid head SHA');
  if (gate.head !== head) out.push(`the gate is for head ${short(gate.head)}, the worktree is at ${short(head)}`);
  if (gate.head !== prHead) out.push(`the gate is for head ${short(gate.head)}, the PR head is ${short(prHead)}`);
  if (typeof gate.contentHash !== 'string' || gate.contentHash === '' || gate.contentHash !== hash) out.push('the patch changed since the gate ran (content hash differs)');
  const at = Date.parse(gate.at);
  if (!Number.isFinite(at)) out.push('the gate has no valid timestamp');
  else if (now - at > GATE_MAX_AGE_MS) out.push(`the gate is ${Math.round((now - at) / 60_000)} minutes old (limit ${GATE_MAX_AGE_MS / 60_000})`);
  else if (at - now > 60_000) out.push('the gate is dated in the future');
  return out;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_CONSECUTIVE_ERRORS = 3;

// The merge commit of a MERGED PR is sometimes not readable in the same instant: look again a few times.
async function readMergeSha({ gh, pr, first, sleep, pollMs }) {
  let sha = first ?? null;
  for (let i = 0; i < MERGE_SHA_RETRIES && !sha; i++) {
    await sleep(Math.min(pollMs, 2000));
    try {
      sha = gh.prView(pr, ['state', 'mergeCommit'])?.mergeCommit?.oid ?? null;
    } catch { /* still unreadable: counts as another miss */ }
  }
  return sha;
}

// The last look before the merge command: GitHub as it is NOW. The live gate read the PR and ran slow probes (Codex, CI,
// preview) after that read, so a label, a pause issue or a new push can have landed since. Returns the reasons the merge
// must not run (empty = go). An unreadable PR is a reason.
export async function preMergeProblems({ gh, pr, head }) {
  let view;
  try {
    view = gh.prView(pr, ['state', 'headRefOid', 'labels', 'isDraft']);
  } catch (err) {
    return [`could not re-read the PR before merging: ${String(err?.message ?? err)}`];
  }
  const problems = [];
  if (view?.state !== 'OPEN') problems.push(`PR state is ${view?.state}`);
  if (view?.isDraft !== false) problems.push('PR is a draft');
  if (view?.headRefOid !== head) problems.push(`PR head is now ${short(view?.headRefOid)}, the gate approved ${short(head)}`);
  problems.push(...(await waitBlockers(gh)(view)));
  return problems;
}

// What can stop a queued merge while we wait: a blocking label, or an open pause/rollback issue. Anything unreadable
// counts as a blocker (the safe direction here is "disable auto-merge").
export function waitBlockers(gh) {
  return async (view) => {
    const problems = [];
    if (!validLabels(view?.labels)) problems.push('PR labels could not be read (labels is missing or malformed)');
    else if (blockingLabelsOf(view.labels).length > 0) problems.push(`blocking label(s): ${blockingLabelsOf(view.labels).join(', ')}`);
    for (const label of ['pipeline-pause', 'pipeline-rollback']) {
      try {
        const issues = gh.listIssues({ label });
        if (!Array.isArray(issues)) throw new Error('issue list was not an array');
        if (issues.length > 0) problems.push(`open ${label} issue #${issues[0]?.number}`);
      } catch (err) {
        problems.push(`could not read the ${label} issues: ${String(err?.message ?? err)}`);
      }
    }
    return problems;
  };
}

// Polls until the PR is MERGED, CLOSED, or the deadline passes. Transient gh errors are tolerated (a flaky call must
// not lose a 15-minute wait) but three in a row surface as 'error'. With `blockers`, every poll of a still-OPEN PR asks
// it for problems and a non-empty answer ends the wait as 'blocked' (the caller disables auto-merge).
export async function waitForMerge({ gh, pr, waitMs, pollMs, now = Date.now, sleep = defaultSleep, blockers = null }) {
  const deadline = now() + waitMs;
  const fields = ['state', 'mergeCommit', ...(blockers ? ['labels'] : [])];
  let errors = 0;
  for (;;) {
    try {
      const view = gh.prView(pr, fields);
      errors = 0;
      if (view.state === 'MERGED') return { state: 'merged', mergeSha: await readMergeSha({ gh, pr, first: view.mergeCommit?.oid, sleep, pollMs }) };
      if (view.state === 'CLOSED') return { state: 'closed' };
      if (blockers) {
        let problems;
        try {
          problems = await blockers(view);
        } catch (err) {
          problems = [`could not check for blockers: ${String(err?.message ?? err)}`];
        }
        if (problems.length > 0) return { state: 'blocked', problems };
      }
    } catch (err) {
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_ERRORS) return { state: 'error', error: String(err?.message ?? err) };
    }
    const left = deadline - now();
    if (left <= 0) return { state: 'timeout' };
    await sleep(Math.min(pollMs, left));
  }
}

// No unattended queued merges: after a failed or timed-out merge, auto-merge must not be left armed. gh errors when
// it was never enabled; that is expected and ignored.
export function disableAutoMerge({ pr, cwd, env }) {
  const r = ghRun(['pr', 'merge', String(pr), '--disable-auto'], { cwd, env, timeoutMs: 60_000 });
  return r.code === 0 && !r.timedOut;
}

// After a failed, blocked or timed-out wait: disarm auto-merge, then LOOK AT THE PR AGAIN. Auto-merge may have fired
// between the last poll and the disable call; a PR that is MERGED must be reported as merged (so prod-watch and the
// summary still run), not as a failure that leaves the caller believing nothing shipped.
export async function abandonMerge({ gh, pr, cwd, env, disable = disableAutoMerge, sleep = defaultSleep, pollMs = 10_000 }) {
  const autoMergeDisabled = disable({ pr, cwd, env });
  let view = null;
  let readError = null;
  try {
    view = gh.prView(pr, ['state', 'mergeCommit']);
  } catch (err) {
    readError = String(err?.message ?? err);
  }
  if (view?.state === 'MERGED') {
    return { autoMergeDisabled, merged: true, mergeSha: await readMergeSha({ gh, pr, first: view.mergeCommit?.oid, sleep, pollMs }) };
  }
  return { autoMergeDisabled, merged: false, mergeSha: null, ...(readError ? { readError } : {}) };
}

// Test hook: PIPELINE_MERGE_WAIT_MS / PIPELINE_MERGE_POLL_MS. The wait can only be SHORTENED (a shorter wait ends in
// "disable auto-merge and fail", which is the safe direction); it can never be stretched past the configured minutes.
export function mergeTiming(config, env = {}) {
  const configured = config.merge.wait_minutes * 60_000;
  const wait = Number(env.PIPELINE_MERGE_WAIT_MS);
  const poll = Number(env.PIPELINE_MERGE_POLL_MS);
  return {
    waitMs: Number.isInteger(wait) && wait >= 0 ? Math.min(wait, configured) : configured,
    pollMs: Number.isInteger(poll) && poll >= 1 ? poll : 10_000,
  };
}
