// The final gate and merge helpers: the last line of defence before an agent merges to production.
// `evaluateGate` proves that THIS exact PR head was fully verified, cross-model reviewed and CI-green;
// `pipeline merge` then refuses anything the gate file does not vouch for. Everything fails
// closed: a check that cannot be evaluated is a failed check, never a skipped one, and a gate that errors out
// leaves no final-gate.json behind (the command deletes the old one first), so stale evidence can never merge.
//
// The evidence is bound to the head in three independent ways: git.head (the report is for this commit),
// git.tree (nothing changed in the working tree since verify ran) and contentHash (the review covered exactly
// this patch). Each one defeats a different mistake, so none is redundant.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gh as ghRun } from './proc.mjs';
import { checkGuardVerdict, GUARD_CONTEXT_CHECKS } from './guard-provenance.mjs';
import { PROVENANCE_CHECKS, REVIEW_CHECK, validateConfig } from './config.mjs';
import { ciProof as defaultCiProof } from './ci-proof.mjs';
import { matchGlob } from './glob.mjs';
import { blockingHits, collectHardStops, ownerMergeHits } from './hardstops.mjs';
import { checkIntegrity } from './integrity.mjs';
import { runPreflight } from './preflight.mjs';
import { toPosix } from './paths.mjs';
import { isDocPath } from './doc-paths.mjs';
import { loadState } from './state.mjs';
import { parseYaml } from './yaml.mjs';
import { ownerRuledItems, reviewValidFor } from './triage.mjs';
import { verifyOwnerGrants } from './owner-grants.mjs';
import { skipOf } from './verify-steps.mjs';
import { NETWORK_TIMEOUT_MS, commitTime, diffFiles, git, headSha, mergeBase, revParse, reviewBaseRef, reviewContentHash, showFile, treeFingerprint } from './git.mjs';
import { ownerItemsDigest } from '../hooks/lib/owner-go.mjs';

export const GATE_FILE = 'final-gate.json';
export const BLOCKING_LABELS = Object.freeze(['needs-human', 'awaiting-review', 'pipeline-blocked']);
// A gate older than this is evidence about a world that may be gone. Since `P merge` re-runs the whole gate live right before
// the merge command (base moved, a pause issue opened, a new push: all re-read), the file only binds the head, patch and owner
// items, so its age limit is the owner's: a day, as long as an owner's "merge" counts (hooks/lib/owner-go.mjs MAX_AGE_MS).
// Waiting for that "merge" no longer forces a new verify.
export const GATE_MAX_AGE_MS = 24 * 60 * 60_000;
export const PR_FIELDS = Object.freeze(['state', 'headRefOid', 'baseRefName', 'isDraft', 'labels', 'mergeable', 'mergeStateStatus']);
// --owner-go also needs the commit GitHub says the PR is based on: its scan range is bound to that, not to a local ref.
export const OWNER_GO_FIELDS = Object.freeze([...PR_FIELDS, 'baseRefOid']);

// What a gate must contain: exactly these checks, each once and passing (config.preview adds none: the gate no longer reads deployments).
// `merge` refuses a gate file that lacks any of them, so a hand-written or truncated file cannot vouch for a merge.
export const CANONICAL_CHECKS = Object.freeze(['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'review', 'ci']);
export const expectedCheckNames = () => [...CANONICAL_CHECKS];

// `gh pr view` computes `mergeable` lazily: UNKNOWN right after a push. Re-read this many times, this far apart.
export const MERGEABLE_RETRIES = 3;
export const MERGEABLE_PAUSE_MS = 2000;
const MERGE_SHA_RETRIES = 3;
const FULL_SHA = /^[0-9a-f]{40}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 8) : String(sha));
// ownerMerge (owner_approval: chat): how many items of this check the owner merges in chat; only present when > 0. ownerItems: one
// line per item (kind, rule or id, file), folded into the gate's ownerItems digest, which the owner's "merge" is bound to (#58).
const check = (name, ok, detail, ownerMerge = 0, ownerItems = []) => ({
  name, ok: ok === true, detail, ...(ownerMerge > 0 ? { ownerMerge } : {}), ...(ownerItems.length > 0 ? { ownerItems } : {}),
});

// ---- review-dir files ---------------------------------------------------------------------------

export const reviewFile = (root, name) => join(root, '.review', name);

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

// ---- classifiers --------------------------------------------------------------------------------

export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
}

// Case-insensitive on purpose: GitHub treats label names that way, and a blocker must not be dodged by a case change.
export function blockingLabelsOf(labels) {
  return labelNames(labels).filter((n) => BLOCKING_LABELS.includes(n.toLowerCase()));
}

const pathsOf = (f) => [f.oldPath, f.newPath, f.path].filter((p) => typeof p === 'string');

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

// `explicit` ({ sha, branch }, --owner-go): scan merge-base(sha, HEAD)..HEAD for the base commit GitHub names (baseRefOid), never a local
// ref. The commit must be a local object already (no fetch here, and no fallback to origin/<branch> or the local branch).
function lazyDiff(root, config, explicit = null) {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      const o = { cwd: root };
      if (explicit !== null) assertBaseObject(explicit, o);
      const mb = mergeBase(explicit !== null ? explicit.sha : baseRefFor(root, config), 'HEAD', o);
      cached = { ok: true, mb, files: diffFiles(mb, 'HEAD', o) };
    } catch (err) {
      cached = { ok: false, error: String(err?.message ?? err) };
    }
    return cached;
  };
}

// Throws unless `explicit.sha` is a commit object in this repository, saying what to do about it.
function assertBaseObject(explicit, o) {
  if (typeof explicit.sha !== 'string' || !FULL_SHA.test(explicit.sha)) {
    throw new Error(`GitHub did not name the PR's base commit (baseRefOid is ${JSON.stringify(explicit.sha ?? null)}): cannot bind the scan to it`);
  }
  try {
    git(['cat-file', '-e', `${explicit.sha}^{commit}`], o);
  } catch {
    throw new Error(`the PR's base commit ${short(explicit.sha)} is not in this repository: run \`git fetch origin ${explicit.branch}\` and try again (the scan never falls back to a local ref)`);
  }
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
// `baseSha` (--owner-go): the base tip is the commit GitHub names, not the local ref.
function behindBase({ info, diff, root, config, baseSha = null }) {
  if (info?.mergeStateStatus === 'BEHIND') return 'GitHub reports the PR is BEHIND its base (mergeStateStatus BEHIND)';
  const d = diff();
  if (!d.ok) return null; // the checks that need the diff report it themselves
  try {
    const ref = baseSha ?? baseRefFor(root, config);
    const tip = baseSha ?? revParse(`${ref}^{commit}`, { cwd: root });
    if (tip !== d.mb) return `the base (${baseSha ? 'GitHub\'s base commit' : ref} at ${short(tip)}) is not an ancestor of HEAD; the branch forked from ${short(d.mb)}`;
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

// Paths a PR may never touch if GitHub's run is to stand in for the local one: the CI setup itself, the pipeline config, the verify
// runner. The repo's own verify.ci_proof_inputs (the deferred suite's specs, runner, deps) are added from the BASE branch.
const CI_PROOF_PROTECTED = Object.freeze(['.github/**', '.claude/pipeline.yml', 'scripts/verify*', 'scripts/verify*/**']);
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const CI_PROOF_STATES = new Set(['pass', 'pending', 'failure', 'missing']);

// The proof settings as the BASE branch has them (never the PR's own copy: a PR must not be able to grant itself a CI proof). Fetches
// the base first; any failure to fetch, read or validate it is { ok: false, reason }, which the caller turns into ci-proof-missing.
function baseProofSettings({ root, config }) {
  const o = { cwd: root };
  const branch = config.default_branch;
  const ref = `origin/${branch}`;
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { ...o, timeoutMs: NETWORK_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: `could not fetch ${ref}: ${firstLine(err)}` };
  }
  try {
    const text = showFile(ref, '.claude/pipeline.yml', o);
    if (text === null) return { ok: false, reason: `${ref} has no .claude/pipeline.yml` };
    const parsed = validateConfig(parseYaml(text));
    if (!parsed.ok) return { ok: false, reason: `${ref}'s .claude/pipeline.yml is not a valid config: ${parsed.errors.slice(0, 2).join('; ')}` };
    const v = parsed.config.verify;
    return {
      ok: true, ref, branch, sha: revParse(`${ref}^{commit}`, o),
      deferrable: v.deferrable_steps ?? [], proof: v.ci_proof ?? {}, inputs: v.ci_proof_inputs ?? [],
    };
  } catch (err) {
    return { ok: false, reason: `could not read the proof settings from ${ref}: ${firstLine(err)}` };
  }
}

// Dry-run twin of baseProofSettings (P merge --dry-run, owner ruling: no shared git state may change): no fetch, no ref update. The
// base's .claude/pipeline.yml is read from GitHub's contents API at the PR's baseRefOid, i.e. the very bytes a fetch would give for that
// commit. The settings' ref AND sha are both that commit: the protected-input scan (diffFiles(ref, 'HEAD')) and the proof check's base
// must never use a local origin/<base> that may be stale. The commit must also exist locally (the diff needs it): no fetching to get it.
// Every failure is { ok: false, reason: 'proof-settings-unverified: …' }, never a silent pass.
function baseProofSettingsReadOnly({ root, config, gh, baseSha }) {
  const o = { cwd: root };
  const unverified = (why) => ({ ok: false, reason: `proof-settings-unverified: ${why}` });
  if (typeof baseSha !== 'string' || !FULL_SHA.test(baseSha)) return unverified('GitHub did not name the base commit of the PR (baseRefOid)');
  try {
    git(['cat-file', '-e', `${baseSha}^{commit}`], o);
  } catch {
    return unverified(`the PR's base commit ${short(baseSha)} is not in this repository (a dry run does not fetch: fetch it, or run the real merge)`);
  }
  let text;
  try {
    const reply = JSON.parse(gh.apiText(`repos/${gh.repo().slug}/contents/.claude/pipeline.yml?ref=${baseSha}`, '[.type, .encoding, .content]'));
    if (!Array.isArray(reply) || reply[0] !== 'file' || reply[1] !== 'base64' || typeof reply[2] !== 'string') return unverified(`GitHub has no readable .claude/pipeline.yml at ${short(baseSha)}`);
    text = Buffer.from(reply[2], 'base64').toString('utf8');
  } catch (err) {
    return unverified(`could not read .claude/pipeline.yml at ${short(baseSha)} from GitHub: ${firstLine(err)}`);
  }
  try {
    const parsed = validateConfig(parseYaml(text));
    if (!parsed.ok) return unverified(`the base's .claude/pipeline.yml is not a valid config: ${parsed.errors.slice(0, 2).join('; ')}`);
    const v = parsed.config.verify;
    return {
      ok: true, ref: baseSha, branch: config.default_branch, sha: baseSha,
      deferrable: v.deferrable_steps ?? [], proof: v.ci_proof ?? {}, inputs: v.ci_proof_inputs ?? [],
    };
  } catch (err) {
    return unverified(`could not parse the base's .claude/pipeline.yml: ${firstLine(err)}`);
  }
}

// The first path of the PR diff (against the base, renames on both sides) that is a protected input, else null. Throws when the diff
// cannot be taken: the caller treats that as ineligible.
function protectedInputHit({ root, settings }) {
  const globs = [...CI_PROOF_PROTECTED, ...settings.inputs];
  for (const file of diffFiles(settings.ref, 'HEAD', { cwd: root })) {
    for (const p of pathsOf(file)) if (globs.some((g) => matchGlob(p, g, { nocase: true }))) return p;
  }
  return null;
}

// One deferred step -> { proof } (GitHub vouches for it) or { problem } (why the gate cannot accept the deferral). Fail closed: every
// path that is not an explicit 'pass' from ciProof with a run attached is a problem, and a throw anywhere is ci-proof-missing.
async function proveDeferredStep({ step, ctx }) {
  const missing = (why) => ({ problem: `ci-proof-missing:${step} (${why})` });
  try {
    const settings = ctx.settings();
    if (!settings.ok) return missing(settings.reason);
    if (!settings.deferrable.includes(step)) return missing(`${settings.ref} does not list ${step} in verify.deferrable_steps`);
    const spec = Object.hasOwn(settings.proof, step) ? settings.proof[step] : undefined;
    if (!isObject(spec)) return missing(`${settings.ref} has no verify.ci_proof entry for ${step}`);
    const hit = ctx.protectedHit();
    if (hit !== null) return missing(`this PR changes ${hit}, an input of the CI proof, so only a local run can vouch for ${step}`);
    const res = await ctx.ciProof({
      root: ctx.root, step, spec: structuredClone(spec), pr: ctx.pr, head: ctx.head, tree: ctx.tree,
      base: { ref: settings.branch, sha: settings.sha }, gh: ctx.gh, env: ctx.env,
    });
    const state = isObject(res) ? res.state : undefined;
    const why = typeof res?.reason === 'string' && res.reason.trim() ? res.reason.trim() : 'no reason given';
    if (!CI_PROOF_STATES.has(state)) return missing(`the CI proof lookup returned ${JSON.stringify(state)}`);
    if (state === 'pending') return { problem: `ci-proof-pending:${step} (${why})` };
    if (state === 'failure') return { problem: `ci-proof-failed:${step} (${why})` };
    if (state === 'missing') return missing(why);
    if (!isObject(res.run)) return missing('the CI proof lookup said pass but named no run');
    return { proof: { step, source: 'ci', run: res.run } };
  } catch (err) {
    return missing(`the CI proof lookup failed: ${firstLine(err)}`);
  }
}

// true when `sha` is a commit here whose tree is HEAD's tree; otherwise why not (a string), or null for a value that is no sha.
function sameTreeAs(sha, o) {
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
  try {
    const theirs = git(['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], o).trim();
    const mine = git(['rev-parse', '--verify', 'HEAD^{tree}'], o).trim();
    return theirs !== '' && theirs === mine ? true : 'its tree is not HEAD\'s tree';
  } catch {
    return 'that commit is not in this repository';
  }
}

// `proofs` is an out-array: filled (in report order) only when this check passes, with where each deferrable step was proved.
// Residual (Phase 3b): .verify/report.json is written by the verify command the agent runs, as the agent's OS user, so it proves only
// what the agent reports; a tool hook cannot tell the verify process's own write from a forged one (and the files guard does not
// cover .verify/ today). What backs it: a step deferred to CI is proved from GitHub (ciProof above), and branch protection requires
// the CI checks on the merge itself.
// readOnly (P merge --dry-run): the base's proof settings come from GitHub at baseSha, not from a fetch (baseProofSettingsReadOnly).
export async function verifyReportCheck({ root, config, head, tree, o, pr, gh, env, ciProof, proofs = [], readOnly = false, baseSha = null }) {
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
  // verify.deferrable_steps (T2) adds a second, separate kind of skip: a step whose local run GitHub's run replaces. Such a step
  // may be reported only as a pass, or as `skipped` with skipKind "ci" (accepted only with a CI proof read from the base branch);
  // a step in BOTH lists must say whether it was skipped locally (skipKind "local": today's rule) or deferred ("ci").
  // A step only in skippable_steps keeps the legacy rule untouched, except that a row claiming a CI deferral is refused there.
  const skippable = Array.isArray(config.verify.skippable_steps) ? config.verify.skippable_steps : [];
  const deferrable = Array.isArray(config.verify.deferrable_steps) ? config.verify.deferrable_steps : [];
  const rows = steps ?? [];
  const skips = rows.map(skipOf).filter(Boolean);
  const notPassed = rows.filter((s) => s?.status !== 'pass' && skipOf(s) === null).map((s) => `${s?.name}=${s?.status}`);
  if (notPassed.length) problems.push(`steps not passing: ${notPassed.join(', ')}`);
  const toProve = [];
  for (const row of rows) {
    const k = skipOf(row);
    if (k === null) continue;
    const legacyRule = () => {
      if (!skippable.includes(k.name)) problems.push(`step ${k.name} was skipped; list it in verify.skippable_steps to allow that`);
      else if (k.reason === '') problems.push(`step ${k.name} was skipped without a reason`);
    };
    if (!deferrable.includes(k.name)) {
      if (k.kind === 'ci') problems.push(`step ${k.name} was deferred to CI; list it in verify.deferrable_steps to allow that`);
      else legacyRule();
      continue;
    }
    const kinds = skippable.includes(k.name) ? 'skipKind "local" or "ci"' : 'skipKind "ci"';
    if (row.status !== 'skipped') problems.push(`step ${k.name} is deferrable: report it as pass or as skipped with ${kinds}, not as a legacy skip`);
    else if (k.kind === 'ci') toProve.push(k.name);
    else if (k.kind === 'local' && skippable.includes(k.name)) legacyRule();
    else problems.push(`step ${k.name} is deferrable: it was skipped with ${k.kind === undefined ? 'no skipKind' : `skipKind ${JSON.stringify(k.kind)}`}, expected ${kinds}`);
  }

  // CI proof for every deferred step. The base-branch settings and the protected-input scan are computed once, on first use.
  const ciProved = new Map();
  if (toProve.length > 0) {
    let settings;
    let hit;
    const ctx = {
      root, pr, head, tree, gh, env, ciProof: ciProof ?? defaultCiProof,
      settings: () => (settings ??= (readOnly ? baseProofSettingsReadOnly({ root, config, gh, baseSha }) : baseProofSettings({ root, config }))),
      protectedHit: () => {
        if (hit === undefined) {
          try {
            hit = protectedInputHit({ root, settings: ctx.settings() });
          } catch (err) {
            hit = `(the PR diff could not be read: ${firstLine(err)})`;
          }
        }
        return hit;
      },
    };
    for (const step of new Set(toProve)) {
      const r = await proveDeferredStep({ step, ctx });
      if (r.proof) ciProved.set(step, r.proof);
      else problems.push(r.problem);
    }
  }

  const g = isObject(report.git) ? report.git : {};
  // A report made on ANOTHER commit whose tree is HEAD's (an amended message, the same tree re-committed) verified exactly these
  // bytes, so it stands: its fingerprint must equal the one this working tree has with that commit as HEAD (git.mjs#treeFingerprint
  // asHead), and it must be younger than THAT commit. What it never stands in for: a deferred step's CI proof, which is read for
  // THIS head above, so the new head's CI run must still vouch for it; and a head with any other tree, which needs a new verify.
  let verifiedAt = head;
  if (g.head !== head) {
    const same = sameTreeAs(g.head, o);
    if (same === true) verifiedAt = g.head;
    else problems.push(`report is for ${short(g.head)}, HEAD is ${short(head)}${same ? ` (${same})` : ''}`);
  }
  if (g.dirty !== false) problems.push('report was produced on a dirty tree');
  // `treeHash` is the spec's spelling of the same field; either must equal the tree as it is now.
  const reportedTree = g.tree ?? g.treeHash;
  let expectedTree = tree;
  if (verifiedAt !== head) {
    try {
      expectedTree = treeFingerprint(o, { asHead: verifiedAt });
    } catch {
      expectedTree = '';
    }
  }
  if (typeof reportedTree !== 'string' || reportedTree === '' || expectedTree === '' || reportedTree !== expectedTree) problems.push('the working tree changed since verify ran');

  const finished = Date.parse(report.finishedAt);
  if (!Number.isFinite(finished)) problems.push('finishedAt is missing or not a date');
  else if (finished < commitTime(verifiedAt, o)) problems.push(`report finished before the ${verifiedAt === head ? 'HEAD' : 'verified'} commit was made`);

  if (problems.length) return check('verify-report', false, problems.join('; '));
  for (const row of rows) {
    if (ciProved.has(row.name)) proofs.push(ciProved.get(row.name));
    else if (row.status === 'pass' && deferrable.includes(row.name)) proofs.push({ step: row.name, source: 'local' });
  }
  const via = ciProved.size > 0 ? `; CI proof: ${[...ciProved.values()].map((p) => `${p.step} via run ${p.run.id ?? '?'} attempt ${p.run.attempt ?? '?'}`).join(', ')}` : '';
  const at = verifiedAt === head ? short(head) : `${short(verifiedAt)}, the same tree as HEAD ${short(head)}`;
  return check('verify-report', true, `full verify passed at ${at} (${steps.length} steps${skips.length ? `: ${steps.length - skips.length} ran, ${skips.length} skipped: ${skips.map((k) => `${k.name} \u2014 ${clip(k.reason, SKIP_REASON_SHOWN)}`).join('; ')}` : ''}${via})`);
}

async function hardstopsCheck({ root, config, diff }) {
  const d = diff();
  if (!d.ok) return check('hardstops', false, `could not diff against the base: ${d.error}`);
  const hits = await collectHardStops({ base: d.mb, head: 'HEAD', cwd: root, config });
  if (hits.length === 0) return check('hardstops', true, 'no hard-stops');
  // Report-only (advisory) hits are listed, never failing: only blocking hits stop the merge.
  const blocking = blockingHits(hits);
  const chatHits = ownerMergeHits(hits);
  const chat = chatHits.length;
  const advisoryCount = hits.length - blocking.length - chat;
  if (blocking.length === 0) {
    if (chat === 0) return check('hardstops', true, `no blocking hard-stops (${advisoryCount} report-only)`);
    // owner_approval: chat: nothing blocks, but the owner must say "merge" for these.
    return check('hardstops', true, `no blocking hard-stops (${chat} owner-merge, ${advisoryCount} report-only)`, chat, chatHits.map((h) => `hardstop ${h.rule} ${h.file ?? ''}`.trim()));
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
    return chat > 0
      ? check('integrity', true, `${chat} owner-merge test-integrity violation(s)`, chat, r.ownerMerge.map((v) => `integrity ${v.rule ?? v.type ?? 'violation'} ${v.file ?? ''}`.trim()))
      : check('integrity', true, 'no test weakening');
  }
  const shown = r.violations.slice(0, 5).map((v) => `${v.rule ?? v.type ?? 'violation'} ${v.file ?? ''}`.trim()).join('; ');
  return check('integrity', false, `${r.violations.length} test-integrity violation(s): ${shown}`);
}

// How many owner-ruled items the review detail lists, and how much of each quote.
const OWNER_RULED_SHOWN = 5;
const OWNER_QUOTE_SHOWN = 100;

// `repo`: the PR's repository (the gh repo). `ownerGo`: { home, now } for the owner's records, tests only (default: the account's own folder).
export function reviewCheck({ root, config, pr, repo, diff, hash, hashError, ownerGo = {}, readOnly = false }) {
  const d = diff();
  if (!d.ok) return check('review', false, `could not diff against the base: ${d.error}`);
  if (isLogOnly(d.files, config.agent_log)) return check('review', true, 'log-only');
  const state = loadState(root, { cleanup: !readOnly }); // a corrupt state throws: caught by the caller as a failed check
  if (!state) return check('review', false, 'no review state at .review/state.json');
  if (!(Number.isInteger(state.pr) && state.pr > 0)) return check('review', false, `review state records no valid PR number (${JSON.stringify(state.pr)}), expected #${pr}`);
  if (state.pr !== pr) return check('review', false, `review state is for PR #${state.pr}, not #${pr}`);
  if (!hash) return check('review', false, `cannot compute the content hash: ${hashError}`);
  if (!reviewValidFor(state, hash)) {
    return check('review', false, `no clean review round covers the current content (${short(hash)}), or findings are unresolved`);
  }
  // A round past review.max_rounds must carry the owner's extra-round grant, re-proved here from the owner's record and its marker (never
  // from the state alone). A grant lets a round run; it is no merge authority, so it is shown but never an owner-merge item.
  const grants = verifyOwnerGrants(state, { repo, pr, maxRounds: config?.review?.max_rounds, ...ownerGo });
  if (!grants.ok) return check('review', false, grants.problems.join('; '));
  const grantNote = grants.granted.map((g) => `; owner-granted round ${g.k}: "${clip(g.quote.replace(/\s+/g, ' ').trim(), OWNER_QUOTE_SHOWN)}"`).join('');
  // owner_approval: chat: an item the owner ruled in chat (an original or a later round's cached copy) never clears the merge by
  // itself. It stays visible here and counts as ownerMerge, so the owner's "merge" for this head is still needed.
  const ruled = ownerRuledItems(state);
  if (ruled.length > 0) {
    const shown = ruled.slice(0, OWNER_RULED_SHOWN).map((i) => `${i.id} "${clip(String(i.final.ownerQuote).replace(/\s+/g, ' ').trim(), OWNER_QUOTE_SHOWN)}"`).join('; ');
    return check('review', true, `review valid for content ${short(hash)}; ${ruled.length} owner-ruled item(s), owner-merge: ${shown}${ruled.length > OWNER_RULED_SHOWN ? '; ...' : ''}${grantNote}`, ruled.length,
      ruled.map((i) => `review ${i.id} ${createHash('sha256').update(String(i.final.ownerQuote)).digest('hex').slice(0, 12)}`));
  }
  return check('review', true, `review valid for content ${short(hash)}${grantNote}`);
}

// CI evidence. Judged: the checks GitHub itself requires (`gh pr checks --required`), or every reported check when it
// requires none. On top of that every check NAMED in config.ci.required_checks must be reported and passing, so a
// required check that never ran (renamed, workflow deleted, path-filtered away) cannot be mistaken for a green PR.
// `skipping` only passes for a trusted docs-only diff. Nothing configured and nothing required by GitHub fails closed,
// unless the owner wrote `ci.required_checks: []` explicitly (then every reported check must pass).
// With ci.review_check the review status is named too (posted by the guards workflow, so only next to its guard checks).
export function ciCheck({ gh, pr, head, diff, config, explicitEmpty }) {
  const reviewNamed = config.ci?.review_check === true && config.ci?.guard_checks !== false;
  const named = [...new Set([...(config.ci?.required_checks ?? []), ...(reviewNamed ? [REVIEW_CHECK] : [])])];
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
    if (r && PROVENANCE_CHECKS.includes(r.name) && passing(r)) guardNames.add(r.name);
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
// readOnly (P merge --dry-run): changes no shared git state. The only step that does is the deferred-CI proof's base-settings read
// (a `git fetch` that moves origin/<base>); readOnly reads them from GitHub at the PR's baseRefOid instead.
export async function evaluateGate({ root, config, pr, gh, env, sleep = defaultSleep, ciProof = defaultCiProof, readOnly = false }) {
  const o = { cwd: root };
  const head = headSha(o);
  const info = await readPrSettled({ gh, pr, fields: readOnly ? [...PR_FIELDS, 'baseRefOid'] : [...PR_FIELDS], sleep, pauseMs: mergeablePause(env) });
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

  const proofs = [];
  const checks = [
    await safely('pr-open', () => prOpenCheck({ info, head, config, behind: behindBase({ info, diff, root, config }) })),
    await safely('labels', () => labelsCheck(info)),
    await safely('preflight', () => preflightCheck({ root, env, gh })),
    await safely('verify-report', () => verifyReportCheck({ root, config, head, tree, o, pr, gh, env, ciProof, proofs, readOnly, baseSha: info?.baseRefOid ?? null })),
    await safely('hardstops', () => hardstopsCheck({ root, config, diff })),
    await safely('integrity', () => integrityCheck({ config, diff })),
    await safely('review', () => reviewCheck({ root, config, pr, repo, diff, hash, hashError, readOnly })),
    await safely('ci', () => ciCheck({ gh, pr, head, diff, config, explicitEmpty: ciExplicitlyEmpty(root) })),
  ];

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
    // owner_approval: chat: items the owner merges in chat (0 = none, merge as usual). The review skill reads this.
    ownerMerge: checks.reduce((n, c) => n + (c.ownerMerge ?? 0), 0),
    // #58: the owner-item set as one digest ('none' without items). The owner's "merge" is recorded against it, and P merge needs the
    // live gate to show the same set: an item added or swapped after the owner said "merge" (same head) needs a new "merge".
    ownerItems: ownerItemsDigest(checks.flatMap((c) => c.ownerItems ?? [])),
    // Where each deferrable verify step was proved (T2): [{ step, source: 'local' }] or [{ step, source: 'ci', run: {...} }]. Only present
    // for a repo that configures verify.deferrable_steps, and only when verify-report passed; P merge records it.
    ...(proofs.length > 0 && checks.find((c) => c.name === 'verify-report')?.ok ? { proofs } : {}),
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    at: new Date().toISOString(),
  };
}

// The checks of `P merge --owner-go` (owner decision 2026-10-28): work that never ran the review skill (no verify report, no review
// state, no final-gate.json) merges on the owner's "merge" alone, provided GitHub agrees the PR is ready: open, not a draft,
// MERGEABLE, not behind its base, at the local HEAD, no blocking label, and every required check green on this head (ciCheck,
// guard statuses and the Cross-model review status only with their provenance). The owner's recorded "merge" is checked by the
// caller. Nothing here vouches for a verify step: no proofs are produced (a deferred step's CI proof is a gate matter), and
// nothing is written, so a later plain `P merge` still needs its own final gate. Returns { ok, head, checks, failed }.
// The agent writes the request lines, so the owner's record is checked against what THIS scan finds (Fable attacker pass): the
// `owner-items` check fails for a blocking hard-stop, a test-integrity violation, or any owner item in `owner_approval: label` mode (the
// label route has no chat "merge" for them). In chat mode an owner item (a hard-stop or integrity item the owner merges in chat) does NOT
// fail it: it is returned as `ownerItems` / `areas`, and `P merge --owner-go` requires the owner's record for exactly that digest and
// the Areas block shown for those areas (hooks/lib/owner-go.mjs approvalGap). A record for `items none` never covers a diff with items.
export const OWNER_GO_CHECKS = Object.freeze(['pr-open', 'labels', 'ci', 'scan-range', 'hardstops', 'integrity', 'owner-items']);

const NAMED_SHOWN = 3;
// GitHub's pulls/{n}/files returns at most this many files, however many pages are read.
const PULL_FILES_CAP = 3000;

// The scan of a --owner-go diff is only as good as the objects it reads. Refused (fail closed) when the range cannot be pinned to GitHub's
// base commit, or when this clone can show a different history than GitHub has: replace refs, a grafts file, a shallow clone. And the
// scanned file list is cross-checked against GitHub's own list for the PR (pulls/{n}/files, both names of a rename): a file GitHub lists
// that the local diff lacks means the local objects are not the PR's. (GIT_NO_REPLACE_OBJECTS already makes our own git reads ignore replace refs.)
function scanRangeCheck({ root, gh, pr, diff, info, explicit }) {
  const o = { cwd: root };
  const problems = [];
  const d = diff();
  if (!d.ok) problems.push(d.error);
  const inspect = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      problems.push(`could not inspect ${what}: ${firstLine(err)}`);
      return null;
    }
  };
  const replaced = inspect('replace refs', () => git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/'], o).trim());
  if (replaced) problems.push(`this repository has replace refs (${replaced}): they can show a history other than GitHub's`);
  const grafts = inspect('the grafts file', () => resolve(root, git(['rev-parse', '--git-path', 'info/grafts'], o).trim()));
  if (grafts && existsSync(grafts)) problems.push('this repository has a grafts file (.git/info/grafts): it can show a history other than GitHub\'s');
  const shallow = inspect('whether the clone is shallow', () => git(['rev-parse', '--is-shallow-repository'], o).trim());
  if (shallow === 'true') problems.push('this repository is a shallow clone: its history is cut short, so the merge-base and the diff cannot be trusted (git fetch --unshallow)');
  if (d.ok) {
    let listed = null;
    let listFailed = false;
    try {
      listed = typeof gh.pullFiles === 'function' ? gh.pullFiles(pr) : null;
    } catch (err) {
      listFailed = true;
      problems.push(`could not read GitHub's file list for the PR (pulls/${pr}/files): ${firstLine(err)}`);
    }
    if (listed !== null) {
      const names = [];
      let malformed = false;
      for (const entry of Array.isArray(listed) ? listed : [null]) {
        if (!isObject(entry) || typeof entry.filename !== 'string' || entry.filename === '') {
          malformed = true;
          continue;
        }
        names.push(entry.filename);
        if (typeof entry.previous_filename === 'string' && entry.previous_filename !== '') names.push(entry.previous_filename);
      }
      if (malformed) problems.push(`GitHub's file list for the PR (pulls/${pr}/files) could not be read (an entry has no filename)`);
      const named = (list) => `${list.slice(0, NAMED_SHOWN).join(', ')}${list.length > NAMED_SHOWN ? ', ...' : ''}`;
      if (Array.isArray(listed) && listed.length >= PULL_FILES_CAP) {
        // GitHub's files API returns at most 3000 files: a list this long may be cut short, so it cannot vouch for the local diff.
        problems.push(`GitHub's file list for the PR (pulls/${pr}/files) has ${listed.length} entries, the most that API returns: too many files to cross-check the local diff against it`);
      } else {
        // Both ways: a file GitHub lists that the local diff lacks (the local objects are not the PR's), and a local file GitHub does not list
        // (an empty or short reply must not pass). A rename counts under both of its names, on both sides.
        const local = new Set(d.files.flatMap(pathsOf));
        const listedNames = new Set(names);
        const absent = [...new Set(names.filter((n) => !local.has(n)))];
        const unlisted = [...local].filter((p) => !listedNames.has(p));
        if (absent.length > 0) {
          problems.push(`GitHub lists ${absent.length} file(s) for the PR that the local diff lacks (${named(absent)}): the local history is not the PR's`);
        }
        if (unlisted.length > 0) {
          problems.push(`the local diff has ${unlisted.length} file(s) that GitHub does not list for the PR (${named(unlisted)}): its file list is incomplete or the local history is not the PR's`);
        }
      }
    } else if (!listFailed) {
      problems.push('GitHub\'s file list for the PR could not be read (this gh client has no pullFiles)');
    }
  }
  return problems.length ? check('scan-range', false, problems.join('; ')) : check('scan-range', true, `scanned merge-base(${short(explicit.sha)}, ${short(info?.headRefOid)})..HEAD, ${d.files.length} file(s), all listed by GitHub`);
}

// The owner-item lines are "<kind> <rule or type> <file>": the area of a line is its second word (hard-stop rule id, integrity kind).
export const areasOf = (lines) => [...new Set(lines.map((l) => String(l).split(' ')[1]).filter((a) => typeof a === 'string' && a !== ''))].sort();

export function ownerItemsCheck({ items, hardstops, integrity, label }) {
  const shown = `${items.length} owner item(s) (${items.slice(0, 3).join('; ')}${items.length > 3 ? '; ...' : ''})`;
  if (!hardstops.ok || !integrity.ok) {
    return check('owner-items', false, `${[!hardstops.ok && 'hardstops', !integrity.ok && 'integrity'].filter(Boolean).join(' and ')} did not pass: no chat "merge" covers a blocking hard-stop or a test-integrity violation${items.length > 0 ? `; also ${shown}` : ''}`);
  }
  if (label && items.length > 0) return check('owner-items', false, `${shown} under owner_approval: label: the owner merges it by hand`);
  // Fail closed: EVERY item the owner would approve must fall in an area, or the Areas line would leave it out (an item line with an empty rule / type).
  const arealess = items.filter((l) => areasOf([l]).length === 0);
  if (arealess.length > 0) return check('owner-items', false, `${arealess.length} owner item(s) name no area (${arealess.slice(0, 3).join('; ')}${arealess.length > 3 ? '; ...' : ''}): a hard-stop rule or integrity kind is empty, so the owner cannot be shown what they fall in`);
  return check('owner-items', true, items.length === 0 ? 'none' : `${shown}: the owner's "merge" must be bound to them (items ${ownerItemsDigest(items)})`);
}

export async function evaluateOwnerGo({ root, config, pr, gh, env, sleep = defaultSleep }) {
  const head = headSha({ cwd: root });
  const info = await readPrSettled({ gh, pr, fields: [...OWNER_GO_FIELDS], sleep, pauseMs: mergeablePause(env) });
  // The range is GitHub's: the PR's base commit and head, as read now. headRefOid must be the local HEAD (pr-open), baseRefOid a local object.
  const explicit = { sha: info?.baseRefOid, branch: typeof info?.baseRefName === 'string' && info.baseRefName !== '' ? info.baseRefName : config.default_branch };
  const baseSha = typeof explicit.sha === 'string' && FULL_SHA.test(explicit.sha) ? explicit.sha : null;
  const diff = lazyDiff(root, config, explicit);
  const hardstops = await safely('hardstops', () => hardstopsCheck({ root, config, diff }));
  const integrity = await safely('integrity', () => integrityCheck({ config, diff }));
  const items = [...(hardstops.ownerItems ?? []), ...(integrity.ownerItems ?? [])];
  const checks = [
    await safely('pr-open', () => prOpenCheck({ info, head, config, behind: behindBase({ info, diff, root, config, baseSha }) })),
    await safely('labels', () => labelsCheck(info)),
    await safely('ci', () => ciCheck({ gh, pr, head, diff, config, explicitEmpty: ciExplicitlyEmpty(root) })),
    await safely('scan-range', () => scanRangeCheck({ root, gh, pr, diff, info, explicit })),
    hardstops,
    integrity,
    ownerItemsCheck({ items, hardstops, integrity, label: config.owner_approval === 'label' }),
  ];
  return {
    ok: checks.every((c) => c.ok),
    head,
    checks,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    // The range that was scanned, as GitHub named it: the final look before the merge command re-reads both and refuses if either moved.
    baseRefOid: baseSha,
    headRefOid: typeof info?.headRefOid === 'string' ? info.headRefOid : null,
    // The owner items of the diff, all from ONE list: their digest ('none' without items), the lines, and the areas they fall in.
    ownerItems: ownerItemsDigest(items),
    ownerItemLines: items,
    areas: areasOf(items),
  };
}

// ---- merge --------------------------------------------------------------------------------------

// Why a gate file does not vouch for merging `pr` at `head` right now. Empty list = it does.
export function gateRefusals({ gate, pr, head, prHead, hash, repo, now = Date.now() }) {
  if (!isObject(gate)) return ['no final-gate.json (or it is unreadable)'];
  const out = [];
  if (gate.ok !== true) out.push('the gate did not pass');
  if (!Array.isArray(gate.checks) || gate.checks.length === 0 || !gate.checks.every((c) => c?.ok === true)) out.push('the gate has failing or missing checks');
  const names = Array.isArray(gate.checks) ? gate.checks.map((c) => (isObject(c) ? c.name : undefined)) : [];
  const expected = expectedCheckNames();
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

// --owner-go: the scan's base commit must be a full sha, whatever the scan-range check says, because the last look (preMergeProblems) only
// re-reads GitHub's baseRefOid when it is given one. Returns the reason to refuse, or null.
export function ownerGoBaseProblem(live) {
  const sha = live?.baseRefOid;
  if (typeof sha === 'string' && FULL_SHA.test(sha)) return null;
  return `GitHub did not name the PR's base commit as a full 40-character sha (baseRefOid is ${JSON.stringify(sha ?? null)}): the base cannot be re-read before the merge`;
}

// The last look before the merge command: GitHub as it is NOW. The live gate read the PR and ran slow probes (Codex, CI)
// after that read, so a label, a pause issue or a new push can have landed since. Returns the reasons the merge
// must not run (empty = go). An unreadable PR is a reason.
// `base` (--owner-go): the base commit the scan was of; GitHub's baseRefOid must still be it.
export async function preMergeProblems({ gh, pr, head, base = null }) {
  let view;
  try {
    view = gh.prView(pr, ['state', 'headRefOid', 'labels', 'isDraft', ...(base !== null ? ['baseRefOid'] : [])]);
  } catch (err) {
    return [`could not re-read the PR before merging: ${String(err?.message ?? err)}`];
  }
  const problems = [];
  if (view?.state !== 'OPEN') problems.push(`PR state is ${view?.state}`);
  if (view?.isDraft !== false) problems.push('PR is a draft');
  if (view?.headRefOid !== head) problems.push(`PR head is now ${short(view?.headRefOid)}, the gate approved ${short(head)}`);
  if (base !== null && view?.baseRefOid !== base) problems.push(`PR base is now ${short(view?.baseRefOid)}, the scan was of ${short(base)}: scan again`);
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
// between the last poll and the disable call; a PR that is MERGED must be reported as merged (so the
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
