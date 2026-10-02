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
import { collectHardStops } from './hardstops.mjs';
import { checkIntegrity } from './integrity.mjs';
import { runPreflight } from './preflight.mjs';
import { matchAny } from './glob.mjs';
import { toPosix } from './paths.mjs';
import { loadState } from './state.mjs';
import { reviewValidFor } from './triage.mjs';
import { commitTime, contentHash, diffFiles, headSha, mergeBase, revParse, treeFingerprint } from './git.mjs';

export const GATE_FILE = 'final-gate.json';
export const BLOCKING_LABELS = Object.freeze(['needs-human', 'awaiting-review', 'pipeline-blocked']);
// A gate older than this is evidence about a world that may be gone (base moved, a pause issue opened).
export const GATE_MAX_AGE_MS = 30 * 60_000;
export const PR_FIELDS = Object.freeze(['state', 'headRefOid', 'baseRefName', 'isDraft', 'labels', 'mergeable']);

const DOCS_GLOBS = ['**/*.md', 'docs/**'];
const FULL_SHA = /^[0-9a-f]{40}$/;
const TAIL_LINES = 30;
const MAX_LINE = 400;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 8) : String(sha));
const check = (name, ok, detail) => ({ name, ok: ok === true, detail });

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

// Every changed file is markdown or under docs/ (a rename counts by BOTH its paths: moving code into docs/ is not docs-only).
export function isDocsOnly(files) {
  return Array.isArray(files) && files.length > 0 && files.every((f) => pathsOf(f).length > 0 && pathsOf(f).every((p) => matchAny(p, DOCS_GLOBS)));
}

// The diff touches only the agent log, and only by adding lines to it (no edits or deletions of history).
export function isLogOnly(files, agentLog) {
  if (!Array.isArray(files) || files.length === 0 || typeof agentLog !== 'string') return false;
  const log = toPosix(agentLog).replace(/^\.\//, '');
  return files.every((f) => f.path === log && (f.status === 'A' || f.status === 'M') && f.binary !== true && f.removed.length === 0);
}

// ---- refs, hashes -------------------------------------------------------------------------------

// `origin/<default>` when the remote ref exists (the PR's real base), else the local default branch.
export function baseRefFor(root, config) {
  const remote = `origin/${config.default_branch}`;
  try {
    revParse(remote, { cwd: root });
    return remote;
  } catch {
    return config.default_branch;
  }
}

// The review's content hash for HEAD: the patch against the merge-base, minus the agent log the pipeline appends to.
// (Same formula as the review loop's own helper; kept private here so the gate does not depend on its file.)
export function localContentHash(root, config) {
  const o = { cwd: root };
  const mb = mergeBase(baseRefFor(root, config), 'HEAD', o);
  return contentHash(mb, 'HEAD', { ...o, exclude: [config.agent_log] });
}

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

function prOpenCheck({ info, head, config }) {
  const problems = [];
  if (info.state !== 'OPEN') problems.push(`PR state is ${info.state}`);
  if (info.isDraft !== false) problems.push('PR is a draft');
  if (info.mergeable === 'CONFLICTING') problems.push('PR has merge conflicts');
  if (info.headRefOid !== head) problems.push(`PR head ${short(info.headRefOid)} is not the local HEAD ${short(head)}`);
  // The hard-stop, integrity and review diffs are taken against the default branch; any other base would be judged on the wrong diff.
  if (info.baseRefName !== config.default_branch) problems.push(`PR base is ${JSON.stringify(info.baseRefName)}, not ${config.default_branch}`);
  return problems.length ? check('pr-open', false, problems.join('; ')) : check('pr-open', true, `open at ${short(head)}`);
}

function labelsCheck(info) {
  const blocking = blockingLabelsOf(info.labels);
  return blocking.length ? check('labels', false, `blocking label(s): ${blocking.join(', ')}`) : check('labels', true, 'no blocking labels');
}

async function preflightCheck({ root, env, gh }) {
  const report = await runPreflight({ cwd: root, env, gh });
  if (report.canMerge) return check('preflight', true, 'pipeline may merge');
  return check('preflight', false, report.reasons.length ? report.reasons.join('; ') : 'preflight says the pipeline may not merge');
}

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

  const steps = Array.isArray(report.steps) ? report.steps : null;
  const expected = Array.isArray(report.expectedSteps) ? report.expectedSteps : null;
  if (!expected || expected.length === 0) problems.push('report has no expectedSteps');
  if (!steps || steps.length === 0) problems.push('report has no steps');
  if (steps && expected && JSON.stringify(steps.map((s) => s?.name)) !== JSON.stringify(expected)) {
    problems.push(`steps [${steps.map((s) => s?.name).join(', ')}] do not match expectedSteps [${expected.join(', ')}]`);
  }
  const notPassed = (steps ?? []).filter((s) => s?.status !== 'pass').map((s) => `${s?.name}=${s?.status}`);
  if (notPassed.length) problems.push(`steps not passing: ${notPassed.join(', ')}`);

  const g = isObject(report.git) ? report.git : {};
  if (g.head !== head) problems.push(`report is for ${short(g.head)}, HEAD is ${short(head)}`);
  if (g.dirty !== false) problems.push('report was produced on a dirty tree');
  // `treeHash` is the spec's spelling of the same field; either must equal the tree as it is now.
  const reportedTree = g.tree ?? g.treeHash;
  if (typeof reportedTree !== 'string' || reportedTree === '' || reportedTree !== tree) problems.push('the working tree changed since verify ran');

  const finished = Date.parse(report.finishedAt);
  if (!Number.isFinite(finished)) problems.push('finishedAt is missing or not a date');
  else if (finished < commitTime(head, o)) problems.push('report finished before the HEAD commit was made');

  return problems.length ? check('verify-report', false, problems.join('; ')) : check('verify-report', true, `full verify passed at ${short(head)} (${steps.length} steps)`);
}

async function hardstopsCheck({ root, config, diff }) {
  const d = diff();
  if (!d.ok) return check('hardstops', false, `could not diff against the base: ${d.error}`);
  const hits = await collectHardStops({ base: d.mb, head: 'HEAD', cwd: root, config });
  if (hits.length === 0) return check('hardstops', true, 'no hard-stops');
  const shown = hits.slice(0, 5).map((h) => `${h.rule} ${h.file ?? ''}`.trim()).join('; ');
  return check('hardstops', false, `${hits.length} hard-stop hit(s): ${shown}${hits.length > 5 ? '; ...' : ''}`);
}

function integrityCheck({ config, diff }) {
  const d = diff();
  if (!d.ok) return check('integrity', false, `could not diff against the base: ${d.error}`);
  // No labels passed: the override label is deliberately not honoured at the gate.
  const r = checkIntegrity({ files: d.files, config, labels: [] });
  if (r.ok) return check('integrity', true, 'no test weakening');
  const shown = r.violations.slice(0, 5).map((v) => `${v.rule ?? v.type ?? 'violation'} ${v.file ?? ''}`.trim()).join('; ');
  return check('integrity', false, `${r.violations.length} test-integrity violation(s): ${shown}`);
}

function reviewCheck({ root, config, pr, diff, hash, hashError }) {
  const d = diff();
  if (!d.ok) return check('review', false, `could not diff against the base: ${d.error}`);
  if (isLogOnly(d.files, config.agent_log)) return check('review', true, 'log-only');
  const state = loadState(root); // a corrupt state throws: caught by the caller as a failed check
  if (!state) return check('review', false, 'no review state at .review/state.json');
  if (Number.isInteger(state.pr) && state.pr > 0 && state.pr !== pr) return check('review', false, `review state is for PR #${state.pr}, not #${pr}`);
  if (!hash) return check('review', false, `cannot compute the content hash: ${hashError}`);
  if (!reviewValidFor(state, hash)) {
    return check('review', false, `no clean review round covers the current content (${short(hash)}), or findings are unresolved`);
  }
  return check('review', true, `review valid for content ${short(hash)}`);
}

function ciCheck({ gh, pr, diff }) {
  let rows = null;
  let source = 'required';
  try {
    rows = gh.checks(pr, { required: true });
  } catch {
    rows = null; // gh says "no required checks reported" on stdout-less exit 1: fall through to all checks
  }
  if (!rows || rows.length === 0) {
    source = 'all';
    rows = gh.checks(pr);
  }
  if (rows.length === 0) return check('ci', false, 'no CI checks reported');
  const d = diff();
  const docsOnly = d.ok && isDocsOnly(d.files);
  const bad = rows.filter((r) => !(r.bucket === 'pass' || (docsOnly && r.bucket === 'skipping')));
  if (bad.length) return check('ci', false, `${bad.length} ${source} check(s) not passing: ${bad.map((r) => `${r.name}=${r.bucket ?? r.state}`).join(', ')}`);
  return check('ci', true, `${rows.length} ${source} check(s) passing${docsOnly ? ' (docs-only: skipped checks accepted)' : ''}`);
}

function previewCheck({ root, head }) {
  const smoke = readReviewJson(root, 'preview-smoke.json');
  if (!smoke) return check('preview', false, 'no preview smoke evidence at .review/preview-smoke.json');
  if (smoke.ok !== true) return check('preview', false, 'preview smoke did not pass');
  if (smoke.sha !== head) return check('preview', false, `preview smoke is for ${short(smoke.sha)}, HEAD is ${short(head)}`);
  return check('preview', true, `preview smoke passed at ${short(head)}`);
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
export async function evaluateGate({ root, config, pr, gh, env }) {
  const o = { cwd: root };
  const head = headSha(o);
  const info = gh.prView(pr, [...PR_FIELDS]);
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
    await safely('pr-open', () => prOpenCheck({ info, head, config })),
    await safely('labels', () => labelsCheck(info)),
    await safely('preflight', () => preflightCheck({ root, env, gh })),
    await safely('verify-report', () => verifyReportCheck({ root, config, head, tree, o })),
    await safely('hardstops', () => hardstopsCheck({ root, config, diff })),
    await safely('integrity', () => integrityCheck({ config, diff })),
    await safely('review', () => reviewCheck({ root, config, pr, diff, hash, hashError })),
    await safely('ci', () => ciCheck({ gh, pr, diff })),
  ];
  if (config.preview !== null) checks.push(await safely('preview', () => previewCheck({ root, head })));

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
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    at: new Date().toISOString(),
  };
}

// ---- merge --------------------------------------------------------------------------------------

// Why a gate file does not vouch for merging `pr` at `head` right now. Empty list = it does.
export function gateRefusals({ gate, pr, head, prHead, hash, now = Date.now() }) {
  if (!isObject(gate)) return ['no final-gate.json (or it is unreadable)'];
  const out = [];
  if (gate.ok !== true) out.push('the gate did not pass');
  if (!Array.isArray(gate.checks) || gate.checks.length === 0 || !gate.checks.every((c) => c?.ok === true)) out.push('the gate has failing or missing checks');
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

// Polls until the PR is MERGED, CLOSED, or the deadline passes. Transient gh errors are tolerated (a flaky call must
// not lose a 15-minute wait) but three in a row surface as 'error'.
export async function waitForMerge({ gh, pr, waitMs, pollMs, now = Date.now, sleep = defaultSleep }) {
  const deadline = now() + waitMs;
  let errors = 0;
  for (;;) {
    try {
      const view = gh.prView(pr, ['state', 'mergeCommit']);
      errors = 0;
      if (view.state === 'MERGED') return { state: 'merged', mergeSha: view.mergeCommit?.oid ?? null };
      if (view.state === 'CLOSED') return { state: 'closed' };
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
