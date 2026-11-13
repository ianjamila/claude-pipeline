// Loads and validates a project's .claude/pipeline.yml. Every other pipeline module reads config through here,
// so a typo or a missing field fails loudly up front (all errors at once) instead of mid-pipeline.
// Fail-closed by design: unknown keys are rejected at every level, numbers are range-checked, and an invalid
// config is never returned (config: null), so nothing can accidentally run on a half-valid one.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { globToRegExp, matchAny } from './glob.mjs';
import { isDocPath } from './doc-paths.mjs';
import { isUniversalHardStopPath } from './hardstops.mjs';
import { showFile } from './git.mjs';

// How many verify proofs a run record holds, and how long a proof step name may be. Defined here (config.mjs is vendored into
// project repos; run-record.mjs is not) and imported by run-record.mjs, so a config this file accepts always fits the record.
export const MAX_PROOFS = 20;
export const MAX_PROOF_STEP = 64;
// verify.ci_proof.<step>.steps: how many CI job steps one proof may require, and how long a GitHub step name may be (the longest
// real step names are a short sentence; the cap only keeps a hostile or mistaken config small).
export const MAX_PROOF_JOB_STEPS = 20;
export const MAX_PROOF_JOB_STEP_NAME = 200;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Frozen so no module can mutate the shared defaults; validateConfig hands out unfrozen copies.
export const DEFAULTS = deepFreeze({
  version: 1,
  enforcement: 'github',
  // owner_approval: how the owner signs off a PR that trips a blocking hard-stop or a test-integrity rule. 'label' = the
  // owner adds human-approved / test-change-approved; 'chat' = no label and CI does not fail on those: the review skill stops
  // before the merge, asks in chat, and runs the merge when the owner says "merge".
  owner_approval: 'label',
  // owner_go: click-to-approve (#261). click 'on' (default) = under owner_approval: chat the review skill may offer the owner's "merge" / "extra round" / rulings as a click on a choice dialog
  // (`--ask` on `merge --dry-run` and `triage round-request|ruling-request`); the owner may still type. 'off' = typed words only. It can only switch clicks OFF: the Claude Code builds a click is trusted on
  // are installed code, never this file. Needs `P owner-go approve-dialog-hooks` run once by the owner.
  owner_go: { click: 'on' },
  default_branch: 'main',
  worktree_dir: '.worktrees',
  // worktrees: `pipeline worktrees prune`. mode 'report' (default) only reports; nothing is removed until 'on'.
  worktrees: {
    mode: 'report',
    protect: ['foundation', '*.stack'],
    min_idle_hours: 24,
    min_merged_hours: 24,
    delete: ['node_modules/', '.next/', 'supabase/.temp/', 'test-results/', 'playwright-report/', 'next-env.d.ts', 'public/sw.js', 'tsconfig.tsbuildinfo', '*.log'],
    archive: ['.review/', '.verify/'],
    memory_dirs: ['~/claude-memory'],
  },
  // stop_queue_wait_minutes: retired with the Stop hook (stop-verify); kept so a config that still sets it validates. Nothing reads it.
  // after_fix: what the verifier runs after review fixes are accepted: 'full' (today) or 'quick' (see `pipeline verify plan-after-fix`).
  verify: { report: '.verify/report.json', screenshots: '.verify/screenshots', stop_queue_wait_minutes: 0, after_fix: 'full' },
  // guard_checks: the tamper-proof "Test integrity" and "Hard-stop scan" statuses are always required on top of
  // required_checks. false only for a repo that does not run the pipeline-guards workflow (e.g. this one).
  // approvers: GitHub logins whose approval labels (human-approved, test-change-approved) count. Empty = the repo owner,
  // which only exists for user-owned repos: an org-owned repo MUST list its approvers. The same logins (or the owner) are the
  // authors whose review-complete comment counts for review_check.
  // review_check: the pipeline-guards workflow also posts a "Cross-model review" status (success only when the latest
  // review-complete comment's content hash is the PR head's), and preflight, `protect` and the gate require it. Off by
  // default: turn it on in the same change that applies branch protection with it, or every merge waits for a missing check.
  ci: { required_checks: [], e2e_label: null, draft_while_iterating: false, guard_checks: true, review_check: false, approvers: [] },
  // {sha} is required: the approved head is passed to the merge so a head that moved after review can never merge.
  // behind_base (read from the BASE branch's copy only, and only by `P merge --owner-go`): 'update' (default) = a PR that lacks commits of its base
  // must be updated and re-verified; 'disjoint' = it may merge as is when main's new commits touch none of the PR's files (and none of the
  // toolchain / CI inputs). behind_base_stale_paths: extra globs whose change on main always forces the update (e.g. package.json, supabase/**).
  merge: { command: 'gh pr merge {pr} --squash --auto --delete-branch --match-head-commit {sha}', wait_minutes: 15, behind_base: 'update', behind_base_stale_paths: [] },
  preview: null,
  production: null,
  smoke_checks: [],
  // smoke_bypass_header: NAME of a request header the smoke sends to the configured origin as a firewall hint (e.g. a
  // Vercel Firewall "Bypass" rule for CI runner IPs). The secret VALUE is never in this file: smoke.mjs reads it from the
  // PIPELINE_SMOKE_BYPASS_KEY environment variable. null = no extra header.
  smoke_bypass_header: null,
  // smoke_bypass_origins: the ONLY origins the header may be sent to (exact match, https, e.g. "https://www.example.com").
  // Required (non-empty) when smoke_bypass_header is set; a preview URL, any other host or localhost never gets the header.
  smoke_bypass_origins: [],
  // ignore_hard_stop_rules: hard-stop rules whose hits do NOT count toward the risk level (they stay hits: reported, owner-merge items, final gate,
  // never the light lane). Only P-path and R4-config may be listed (RISK_IGNORABLE_RULES). The rating also reads the config committed at the PR's
  // fork point and the stricter of the two wins (risk.mjs#rateBranch), so a PR cannot loosen its own rating.
  risk: { high_risk_paths: [], medium_lines: 150, high_lines: 600, medium_files: 10, ignore_hard_stop_rules: [] },
  hard_stops: { paths: [], patterns: [], auth_calls: [], disable_rules: [], report_only_rules: [], report_only_paths: [] },
  integrity: {
    test_globs: [
      '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', 'e2e/**', 'supabase/tests/**',
      '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/*_spec.rb', 'spec/**', 'cypress/**', '**/*.cy.*',
    ],
  },
  review: {
    codex_model: 'gpt-6-astra',
    effort: { low: 'medium', medium: 'medium', high: 'high', followup: 'medium' },
    max_rounds: 2,
    light_lane_max_lines: 50,
    // Who reviews after Codex when a PR is medium ONLY for its size (no hard-stop hit of any kind, no sensitive path): 'judge' (Sonnet) or 'fable'.
    size_only_medium_reviewer: 'judge',
    // Paths whose every review round gets the Fable pass (triage + its own review), whatever the risk level.
    arbiter_always_paths: [],
    // EXACT repo-relative paths of ordinary documents (lib/doc-paths.mjs#isDocPath, no hard-stop path, not under supabase/ or a
    // migrations directory, not on integrity.test_globs, hard_stops.paths, review.arbiter_always_paths or risk.high_risk_paths).
    // A commit after the last review round that only ADDS lines to these files needs no new round (lib/docs-exempt.mjs).
    // Empty = off.
    docs_exempt_paths: [],
  },
  agent_log: 'docs/agent-log.md',
});

// The two required statuses pipeline-guards.yml posts (templates/scripts/pipeline/ci-guards-run.mjs CONTEXTS).
export const GUARD_CHECKS = Object.freeze(['Test integrity', 'Hard-stop scan']);
// The third one, posted only with ci.review_check (lib/review-marker.mjs#REVIEW_CONTEXT, the same string).
export const REVIEW_CHECK = 'Cross-model review';
// Every context the guards workflow may post: a passing row with one of these names is only believed with its provenance
// (finalgate.mjs#ciCheck), whatever the config says about requiring it.
export const PROVENANCE_CHECKS = Object.freeze([...GUARD_CHECKS, REVIEW_CHECK]);

// Every status context branch protection must require: what the project lists plus, unless ci.guard_checks is false, the
// two guard contexts, plus the review context with ci.review_check. Without them a repo that lists no checks would read as
// "protected" with nothing required at all.
export function requiredChecks(ci) {
  const configured = Array.isArray(ci?.required_checks) ? ci.required_checks : [];
  const guards = ci?.guard_checks === false ? [] : GUARD_CHECKS;
  const review = ci?.guard_checks !== false && ci?.review_check === true ? [REVIEW_CHECK] : [];
  return [...new Set([...configured, ...guards, ...review])];
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LANES = ['low', 'medium', 'high', 'followup'];
const OWNER_APPROVALS = ['label', 'chat'];
const OWNER_GO_CLICKS = ['on', 'off'];
const PROVIDERS = ['vercel', 'github-deployments', 'other'];
// Who owns the production smoke: a session or a CI workflow that posts the result on the merged PR.
// `preview` and `production` are validated exactly as before, but the final gate and `pipeline merge` no longer read them;
// `pipeline smoke` reads `preview.smoke` and `production.smoke` (and `agent-log close` the watch mode).
const WATCH_MODES = ['session', 'workflow'];
const AFTER_FIX_MODES = ['full', 'quick'];
// Lowercase "x-" + 1..60 of [a-z0-9-]: no standard header (authorization, cookie, ...) can match, so the smoke can never
// be turned into an authenticated request by configuration. smoke.mjs imports this too, so both sides agree.
export const SMOKE_BYPASS_HEADER_RE = /^x-[a-z0-9-]{1,60}$/;
// An https origin exactly as `new URL(x).origin` prints it (no path, query, fragment, credentials, default port or uppercase).
export function isSmokeBypassOrigin(x) {
  if (typeof x !== 'string') return false;
  try {
    const u = new URL(x);
    return u.protocol === 'https:' && !u.username && !u.password && x === u.origin && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(u.hostname); // no wildcards
  } catch {
    return false;
  }
}
// A smoke request path: one leading "/" (never "//"), no backslash, no control characters. A path that does not start with a
// single "/" could turn "https://site" + path into another host ("@evil.example/x" -> userinfo; "//evil" or "/\\evil" -> a
// protocol-relative or backslash host), so the smoke refuses it; smoke.mjs imports this too and re-checks the final origin.
export function isSmokePath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(p);
}
export const SAFE_STEP = /^[A-Za-z0-9_.:-]+$/;

// The cooperative merge-hold seam (all three or none; see checkMergeHold). Absent = no pipeline-side hold handling at all.
// Rollout: a pipeline version that does not know these keys rejects the config (unknown key), so install the pipeline that
// knows them BEFORE a repo sets them. Rollback: remove the three keys first. That also removes the pipeline-side enforcement
// (the repo's own merge command, if it is hold-aware, still enforces). Enforcement is cooperative: the pipeline checks before
// it updates or merges, and only a hold-aware merge command catches a hold placed between that check and the merge itself.
// Renewal starvation: a PR whose hold expires and is renewed goes to the back of the queue; the owner's exits are merging
// the PR ahead, the provider's own release of that PR, or the provider's own override.
export const MERGE_HOLD_KEYS = ['hold_command', 'hold_release_command', 'hold_check_command'];
export const BEHIND_BASE_MODES = Object.freeze(['update', 'disjoint']);

// Allowed keys per mapping. Anything else is a typo (or a removed option) and is rejected.
const KEYS = {
  top: [...Object.keys(DEFAULTS), 'project'],
  owner_go: ['click'],
  worktrees: ['mode', 'protect', 'min_idle_hours', 'min_merged_hours', 'delete', 'archive', 'memory_dirs'],
  verify: ['full', 'quick', 'report', 'screenshots', 'expected_steps', 'skippable_steps', 'stop_queue_wait_minutes', 'after_fix', 'after_fix_steps_by_path', 'after_fix_never', 'max_parallel_full', 'max_load', 'max_load_wait_minutes', 'deferrable_steps', 'ci_proof', 'ci_proof_inputs', 'ci_proof_wait_minutes'],
  ci_proof: ['workflow', 'job', 'event', 'steps'],
  ci: ['required_checks', 'e2e_label', 'draft_while_iterating', 'guard_checks', 'review_check', 'approvers'],
  merge: ['command', 'wait_minutes', 'behind_base', 'behind_base_stale_paths', ...MERGE_HOLD_KEYS],
  preview: ['environment', 'smoke', 'provider'],
  production: ['url', 'provider', 'environment', 'smoke', 'deploy_timeout_minutes', 'rollback', 'watch'],
  rollback: ['command', 'notes'],
  risk: ['high_risk_paths', 'medium_lines', 'high_lines', 'medium_files', 'ignore_hard_stop_rules'],
  hard_stops: ['paths', 'patterns', 'auth_calls', 'disable_rules', 'report_only_rules', 'report_only_paths'],
  pattern: ['name', 'regex', 'paths'],
  integrity: ['test_globs'],
  review: ['codex_model', 'effort', 'max_rounds', 'light_lane_max_lines', 'size_only_medium_reviewer', 'arbiter_always_paths', 'docs_exempt_paths'],
  smoke: ['path', 'status', 'contains', 'location_contains'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const inRange = (v, min, max) => isInt(v) && v >= min && v <= max;

// defineProperty (not assignment) so a hostile "__proto__" key stays a plain own property instead of re-parenting.
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// Arrays replace, plain objects merge, everything else (incl. null) replaces. Always returns fresh copies so
// callers can mutate the result without touching DEFAULTS or the parsed input.
function merge(base, over) {
  if (over === undefined) return structuredClone(base);
  if (isObj(base) && isObj(over)) {
    const out = {};
    for (const k of Object.keys(base)) put(out, k, merge(base[k], Object.hasOwn(over, k) ? over[k] : undefined));
    for (const k of Object.keys(over)) if (!Object.hasOwn(base, k)) put(out, k, structuredClone(over[k]));
    return out;
  }
  return structuredClone(over);
}

// Why `p` may not be listed in review.docs_exempt_paths, or null when it may. `lists` is [[name, globs]] of the project's own
// protected paths (integrity.test_globs, hard_stops.paths, review.arbiter_always_paths, risk.high_risk_paths). Used by validation
// AND by lib/docs-exempt.mjs at run time, so a list that skipped validation is judged by the same rules. Two parts, both required:
// it IS an ordinary document, and nothing protects its path. Globs match case-insensitively (over-matching is the safe direction);
// a glob that cannot be read protects everything.
export function docsExemptProblem(p, lists = []) {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  if (/[\x00-\x1f\x7f\\]/.test(p)) return 'must not contain control characters or backslashes';
  if (/[*?[\]{}]/.test(p)) return 'must be an exact path, not a glob';
  const parts = p.split('/');
  if (p.startsWith('/') || parts.some((s) => s === '' || s === '.' || s === '..')) return 'must be a normalised repo-relative path (no leading "/" or "./", no "..", no trailing "/")';
  if (!isDocPath(p)) return 'is not an ordinary document (markdown anywhere, text/rst/adoc under docs/, LICENSE/CHANGELOG; never an agent instruction file (CLAUDE / AGENTS / AGENT / GEMINI .md and their .<variant>.md forms such as .override.md / .local.md, .cursorrules, copilot-instructions.md), html, mdx, source, or a file under a dot-directory (.claude, .github, .cursor ...), app/, pages/, skills/, agents/, pipeline/ or scripts/)';
  if (parts.slice(0, -1).some((s) => ['supabase', 'migrations'].includes(s.toLowerCase()))) return 'is under supabase/ or a migrations directory';
  if (isUniversalHardStopPath(p)) return 'is claimed by a hard-stop path rule (secrets, auth, sensitive data, pipeline or agent-instruction files ...)';
  for (const [name, globs] of lists) {
    try {
      if (Array.isArray(globs) && matchAny(p, globs.filter((g) => typeof g === 'string'), { nocase: true })) return `is protected by ${name}`;
    } catch {
      return `cannot be judged: a glob in ${name} could not be read`;
    }
  }
  return null;
}

// review.docs_exempt_paths: an array of exact, distinct, eligible document paths.
function checkDocsExempt(config, errors) {
  const list = config.review?.docs_exempt_paths;
  if (!Array.isArray(list)) return errors.push('review.docs_exempt_paths must be an array of exact document paths');
  const lists = [
    ['integrity.test_globs', config.integrity?.test_globs],
    ['hard_stops.paths', config.hard_stops?.paths],
    ['review.arbiter_always_paths', config.review?.arbiter_always_paths],
    ['risk.high_risk_paths', config.risk?.high_risk_paths],
  ];
  const seen = new Set();
  list.forEach((p, i) => {
    const why = docsExemptProblem(p, lists);
    if (why) errors.push(`review.docs_exempt_paths[${i}] (${JSON.stringify(p)}) ${why}`);
    else if (seen.has(p)) errors.push(`review.docs_exempt_paths[${i}] (${JSON.stringify(p)}) is listed twice`);
    seen.add(p);
  });
}

// Optional. verify.after_fix_steps_by_path: { "<glob>": [step, ...] } - the extra steps (run as `verify.full --only ...`) a
// quick after-fix verify adds when the round's fix diff touches a matching path. verify.after_fix_never: steps that may never
// be run that way (they stay full-verify only), so none of them may appear in the map.
function checkAfterFix(verify, errors) {
  const never = verify.after_fix_never;
  let neverOk = false;
  if (never !== undefined) {
    if (!Array.isArray(never) || !never.every(isStr)) errors.push('verify.after_fix_never must be an array of non-empty step names');
    else if (new Set(never).size !== never.length) errors.push('verify.after_fix_never must not repeat a step name');
    else neverOk = true;
  }
  const map = verify.after_fix_steps_by_path;
  if (map === undefined) return;
  if (!isObj(map)) {
    errors.push('verify.after_fix_steps_by_path must be a mapping of glob -> list of step names');
    return;
  }
  const expected = Array.isArray(verify.expected_steps) && verify.expected_steps.every(isStr) ? verify.expected_steps : null;
  for (const [glob, steps] of Object.entries(map)) {
    const where = `verify.after_fix_steps_by_path[${JSON.stringify(glob)}]`;
    if (!isStr(glob)) {
      errors.push('verify.after_fix_steps_by_path globs must be non-empty strings');
      continue;
    }
    try {
      globToRegExp(glob);
    } catch (err) {
      errors.push(`${where}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(steps) || steps.length === 0 || !steps.every(isStr)) {
      errors.push(`${where} must be a non-empty array of non-empty step names`);
      continue;
    }
    if (new Set(steps).size !== steps.length) errors.push(`${where} must not repeat a step name`);
    // These names are put on a command line (`--only a,b`), so they stay shell-inert.
    if (steps.every(isStr) && steps.some((n) => !SAFE_STEP.test(n))) errors.push(`${where}: step names may only use letters, digits and . _ : -`);
    if (neverOk) {
      const banned = steps.filter((n) => never.includes(n));
      if (banned.length) errors.push(`${where} lists step(s) that verify.after_fix_never forbids: ${banned.join(', ')}`);
    }
    if (expected) {
      const unknown = steps.filter((n) => !expected.includes(n));
      if (unknown.length) errors.push(`${where} names step(s) not in verify.expected_steps: ${unknown.join(', ')}`);
    }
  }
}

// Optional. verify.max_parallel_full: at most this many full verifies (of any repo) run at once on one machine; the rest queue
// (`pipeline verify slot --run`). verify.max_load (needs it): after getting a slot, wait while the 1-minute load average is above
// this, for at most verify.max_load_wait_minutes (default 10, never above 10), then run anyway.
function checkSlots(verify, errors) {
  const { max_parallel_full: slots, max_load: load, max_load_wait_minutes: wait } = verify;
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (slots !== undefined && !(isInt(slots) && slots >= 1)) errors.push('verify.max_parallel_full must be a positive integer');
  if (load !== undefined) {
    if (!positive(load)) errors.push('verify.max_load must be a positive number');
    else if (slots === undefined) errors.push('verify.max_load needs verify.max_parallel_full (the load check runs after a slot is taken)');
  }
  if (wait !== undefined) {
    if (!positive(wait) || wait > 10) errors.push('verify.max_load_wait_minutes must be a number above 0 and at most 10');
    else if (load === undefined) errors.push('verify.max_load_wait_minutes needs verify.max_load');
  }
  if (load !== undefined && wait === undefined) verify.max_load_wait_minutes = 10;
}

// Optional. verify.deferrable_steps: steps whose local run the final gate may replace with a GitHub Actions run (a verify report row
// `skipped` + `skipKind: ci`). verify.ci_proof: { <step>: { workflow, job, event } } names that run by workflow FILE and job (never
// by a check name alone); every deferrable step needs an entry and every entry a deferrable step. An entry may also carry `steps`:
// the exact names of steps INSIDE that job that must each have run and succeeded (a job with a step-level skip, e.g. a docs-only
// PR, reports success although every work step was skipped; ci-proof.mjs rule 5 then refuses the proof). verify.ci_proof_inputs: globs of
// extra files whose change makes a PR ineligible for CI proof. verify.ci_proof_wait_minutes: how long the review skill waits for the
// proof (no default: unset = it does not wait). The GATE reads deferrable_steps / ci_proof / ci_proof_inputs from the base branch.
export const CI_PROOF_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
function checkCiProof(verify, errors) {
  const { deferrable_steps: deferrable, ci_proof: proof, ci_proof_inputs: inputs, ci_proof_wait_minutes: wait } = verify;
  let deferrableOk = false;
  if (deferrable !== undefined) {
    if (!Array.isArray(deferrable) || deferrable.length === 0 || !deferrable.every(isStr)) errors.push('verify.deferrable_steps must be a non-empty array of non-empty step names');
    else if (new Set(deferrable).size !== deferrable.length) errors.push('verify.deferrable_steps must not repeat a step name');
    else {
      deferrableOk = true;
      if (deferrable.length > MAX_PROOFS) errors.push(`verify.deferrable_steps lists ${deferrable.length} steps: at most ${MAX_PROOFS} (the run record holds that many proofs)`);
      if (deferrable.some((n) => n.length > MAX_PROOF_STEP)) errors.push(`verify.deferrable_steps: step names may be at most ${MAX_PROOF_STEP} characters`);
      if (deferrable.some((n) => !SAFE_STEP.test(n))) errors.push('verify.deferrable_steps: step names may only use letters, digits and . _ : -');
      if (Array.isArray(verify.expected_steps)) {
        const unknown = deferrable.filter((n) => !verify.expected_steps.includes(n));
        if (unknown.length) errors.push(`verify.deferrable_steps names step(s) not in verify.expected_steps: ${unknown.join(', ')}`);
      }
    }
  }
  if (proof !== undefined) {
    if (!isObj(proof)) errors.push('verify.ci_proof must be a mapping of step -> { workflow, job, event, steps? }');
    else {
      if (Object.keys(proof).length > MAX_PROOFS) errors.push(`verify.ci_proof has ${Object.keys(proof).length} entries: at most ${MAX_PROOFS}`);
      if (Object.keys(proof).some((n) => n.length > MAX_PROOF_STEP)) errors.push(`verify.ci_proof: step names may be at most ${MAX_PROOF_STEP} characters`);
      for (const [step, spec] of Object.entries(proof)) {
        const where = `verify.ci_proof[${JSON.stringify(step)}]`;
        if ((deferrable === undefined || deferrableOk) && !(deferrable ?? []).includes(step)) errors.push(`${where}: ${step} is not listed in verify.deferrable_steps`);
        if (!isObj(spec)) {
          errors.push(`${where} must be a mapping with workflow, job and event`);
          continue;
        }
        unknownKeys(spec, KEYS.ci_proof, `${where}.`, errors);
        if (typeof spec.workflow !== 'string' || !CI_PROOF_WORKFLOW.test(spec.workflow) || spec.workflow.split('/').some((p) => p === '..' || p === '.')) {
          errors.push(`${where}.workflow must be a workflow file path like .github/workflows/ci.yml`);
        }
        if (!isStr(spec.job)) errors.push(`${where}.job must be a non-empty job name`);
        if (spec.event === undefined) spec.event = 'pull_request';
        else if (!isStr(spec.event)) errors.push(`${where}.event must be a non-empty event name`);
        if (spec.steps !== undefined) {
          const st = spec.steps;
          if (!Array.isArray(st) || st.length === 0 || !st.every(isStr)) errors.push(`${where}.steps must be a non-empty array of non-empty step names`);
          else if (new Set(st).size !== st.length) errors.push(`${where}.steps must not repeat a step name`);
          else {
            if (st.length > MAX_PROOF_JOB_STEPS) errors.push(`${where}.steps lists ${st.length} steps: at most ${MAX_PROOF_JOB_STEPS}`);
            if (st.some((n) => n.length > MAX_PROOF_JOB_STEP_NAME)) errors.push(`${where}.steps: step names may be at most ${MAX_PROOF_JOB_STEP_NAME} characters`);
          }
        }
      }
      if (deferrableOk) {
        const bare = deferrable.filter((n) => !Object.hasOwn(proof, n));
        if (bare.length) errors.push(`verify.deferrable_steps lists step(s) with no verify.ci_proof entry: ${bare.join(', ')}`);
      }
    }
  } else if (deferrableOk) {
    errors.push(`verify.deferrable_steps needs verify.ci_proof (an entry for each of: ${deferrable.join(', ')})`);
  }
  if (inputs !== undefined) {
    if (!Array.isArray(inputs) || !inputs.every(isStr)) errors.push('verify.ci_proof_inputs must be an array of non-empty globs');
    else {
      for (const g of inputs) {
        try {
          globToRegExp(g);
        } catch (err) {
          errors.push(`verify.ci_proof_inputs[${JSON.stringify(g)}]: ${err.message}`);
        }
      }
      if (proof === undefined) errors.push('verify.ci_proof_inputs needs verify.ci_proof');
    }
  }
  if (wait !== undefined) {
    if (!(typeof wait === 'number' && Number.isFinite(wait) && wait > 0)) errors.push('verify.ci_proof_wait_minutes must be a number above 0');
    else if (proof === undefined) errors.push('verify.ci_proof_wait_minutes needs verify.ci_proof');
  }
}

function unknownKeys(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`unknown key: ${prefix}${k}`);
}

// Returns the section if it is a mapping (after rejecting its unknown keys), else records an error and returns null
// so the caller skips that section's field checks instead of cascading errors.
function section(config, key, errors) {
  const v = config[key];
  if (!isObj(v)) {
    errors.push(`${key} must be a mapping`);
    return null;
  }
  unknownKeys(v, KEYS[key], `${key}.`, errors);
  return v;
}

// merge.hold_command / hold_release_command / hold_check_command: all three or none. Each is a shell command template
// filled by the pipeline: {pr} (the session's own PR) everywhere, {reason} (a fixed text, shell-quoted) in the release command
// only, never {sha} (a hold is about the PR, not a head). The check command is read-only, so it must differ from the other two:
// a copied take command would make every dry run write a label.
const HOLD_PLACEHOLDERS = {
  hold_command: ['pr'],
  hold_release_command: ['pr', 'reason'],
  hold_check_command: ['pr'],
};
function checkMergeHold(mergeSec, errors) {
  const present = MERGE_HOLD_KEYS.filter((k) => mergeSec[k] !== undefined);
  if (present.length === 0) return;
  if (present.length !== MERGE_HOLD_KEYS.length) {
    errors.push(`merge.hold_command, merge.hold_release_command and merge.hold_check_command are set all three or none (missing: ${MERGE_HOLD_KEYS.filter((k) => !present.includes(k)).map((k) => `merge.${k}`).join(', ')})`);
  }
  for (const k of present) {
    const v = mergeSec[k];
    if (!isStr(v)) {
      errors.push(`merge.${k} must be a non-empty string`);
      continue;
    }
    const wanted = HOLD_PLACEHOLDERS[k];
    const used = new Set([...v.matchAll(/(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
    for (const name of wanted) if (!used.has(name)) errors.push(`merge.${k} must contain {${name}}`);
    for (const name of used) {
      if (wanted.includes(name)) continue;
      errors.push(name === 'sha' ? `merge.${k} must not contain {sha} (a hold belongs to the PR, not to a head)` : `merge.${k} must not contain {${name}} (only ${wanted.map((w) => `{${w}}`).join(' and ')} are filled)`);
    }
  }
  const check = mergeSec.hold_check_command;
  if (isStr(check)) {
    for (const k of ['hold_command', 'hold_release_command']) {
      if (isStr(mergeSec[k]) && mergeSec[k].trim() === check.trim()) errors.push(`merge.hold_check_command must differ from merge.${k} (the check is read-only; a copy of a writing command would write on every dry run)`);
    }
  }
}

function checkStrArray(value, name, errors) {
  if (!isStrArray(value)) errors.push(`${name} must be an array of strings`);
}

// Finite (Number.isInteger rules out NaN and Infinity) and > 0: a threshold of 0, a negative one or a fractional one is a
// typo or a way to make a check vacuous, never a setting anyone means.
function checkPosInt(value, name, errors) {
  if (!isInt(value) || value < 1) errors.push(`${name} must be a positive integer`);
}

function checkUrlTemplate(value, name, errors) {
  if (!isStr(value)) errors.push(`${name} is required (a non-empty string containing {url})`);
  else if (!value.includes('{url}')) errors.push(`${name} must contain {url}`);
}

function checkPreview(p, errors) {
  if (!isObj(p)) return errors.push('preview must be null or a mapping');
  unknownKeys(p, KEYS.preview, 'preview.', errors);
  if (!isStr(p.environment)) errors.push('preview.environment is required (a non-empty string)');
  checkUrlTemplate(p.smoke, 'preview.smoke', errors);
  if (p.provider === undefined) p.provider = 'github-deployments';
  else if (!isStr(p.provider)) errors.push('preview.provider must be a string');
}

function checkProduction(p, errors) {
  if (!isObj(p)) return errors.push('production must be null or a mapping');
  unknownKeys(p, KEYS.production, 'production.', errors);
  if (!isStr(p.url) || !/^https:\/\/\S+$/.test(p.url)) errors.push('production.url is required and must be an https URL');
  if (!isStr(p.environment)) errors.push('production.environment is required (a non-empty string)');
  checkUrlTemplate(p.smoke, 'production.smoke', errors);
  if (!isObj(p.rollback) || !isStr(p.rollback.command)) {
    errors.push('production.rollback.command is required (a non-empty string)');
  } else {
    unknownKeys(p.rollback, KEYS.rollback, 'production.rollback.', errors);
    if (p.rollback.notes !== undefined && typeof p.rollback.notes !== 'string') {
      errors.push('production.rollback.notes must be a string');
    }
  }
  if (p.provider === undefined) p.provider = 'github-deployments';
  else if (!PROVIDERS.includes(p.provider)) errors.push(`production.provider must be one of ${PROVIDERS.join('|')}`);
  if (p.deploy_timeout_minutes === undefined) p.deploy_timeout_minutes = 20;
  else if (!inRange(p.deploy_timeout_minutes, 1, 120)) errors.push('production.deploy_timeout_minutes must be an integer 1..120');
  if (p.watch === undefined) p.watch = 'session';
  else if (!WATCH_MODES.includes(p.watch)) errors.push(`production.watch must be one of ${WATCH_MODES.join('|')}`);
}

// Built-in hard-stop rule families a project may switch off with hard_stops.disable_rules. Deliberately ONE: R6, whose
// only triggers are a sensitive-data WORD in a path or an added line, which a domain can make routine (an HR/payroll app
// mentions payroll everywhere). Before adding a rule here, read every sink.add of it in hardstops.mjs: R5-major-dep is
// NOT eligible although its name says "major version" — it also carries every overrides/resolutions change (a supply-
// chain lever), engines.node, and the fail-closed "package.json could not be parsed; dependency changes unchecked".
// Migrations, destructive SQL, auth paths and removed guards, secrets, pipeline files, dependencies and unscannable
// input stay on for every project; naming one of them is a config error, not a silent no-op.
// Rules risk.ignore_hard_stop_rules may list: their hits stop counting toward the risk LEVEL (not toward anything else). Never the database / auth /
// secret rules, nor R4-pipeline (the guard core: a PR that edits the rating config is itself an R4-pipeline hit, so it cannot lower its own rating).
export const RISK_IGNORABLE_RULES = Object.freeze(['P-path', 'R4-config']);
export const SIZE_ONLY_REVIEWERS = Object.freeze(['judge', 'fable']);

function checkIgnoreRules(rules, errors) {
  if (!Array.isArray(rules)) return errors.push('risk.ignore_hard_stop_rules must be an array');
  rules.forEach((r, i) => {
    if (!RISK_IGNORABLE_RULES.includes(r)) {
      errors.push(`risk.ignore_hard_stop_rules[${i}]: ${JSON.stringify(r)} cannot be ignored for risk (allowed: ${RISK_IGNORABLE_RULES.join(', ')})`);
    }
  });
}

export const DISABLEABLE_HARD_STOP_RULES = Object.freeze(['R6-sensitive']);

function checkDisableRules(rules, errors) {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) return errors.push('hard_stops.disable_rules must be an array');
  rules.forEach((r, i) => {
    if (!DISABLEABLE_HARD_STOP_RULES.includes(r)) {
      errors.push(`hard_stops.disable_rules[${i}]: ${JSON.stringify(r)} cannot be disabled (allowed: ${DISABLEABLE_HARD_STOP_RULES.join(', ')})`);
    }
  });
}

// Built-in hard-stop rule families a project may downgrade to REPORT-ONLY with hard_stops.report_only_rules: the hit is
// still found and listed (job summary, CLI output, PR body) but it never blocks merge and never needs `human-approved`.
// Owner decision 2026-10-09: the label is for DATABASE changes only, so every rule that is not a database rule may be
// downgraded, with one exception: the guard core. NOT eligible, each for a stated reason:
//   R0-unscannable      content nobody could read (a binary, an unparseable lockfile or package.json) vouches for nothing
//   R1-destructive, R1-migration-edited, R2-sql-removed, R2-sql-statement
//                       the database rules the label exists for (R1-destructive covers raw destructive SQL, SQL in code,
//                       deleted/moved migrations)
//   R4-pipeline         the GUARD CORE: anything that decides whether a label is needed or which checks CI runs (workflows,
//                       .claude/, CODEOWNERS, scripts/pipeline, pipeline.yml, test-runner configs, scripts/verify*, lint /
//                       tsconfig / build config, changed or removed package.json scripts, gitlinks, symlinks, deleted pgTAP
//                       tests, package.json gate blocks): one unattended edit there could otherwise turn the database rules
//                       report-only too, so it must stay blocking
//   P-path              a project path rule has its own switch, hard_stops.report_only_paths
// Eligible by owner decision 2026-10-09:
//   R1-data-write       APPLICATION code that deletes or overwrites rows through a client (.from(...).delete/upsert) is
//                       routine feature code; the same call in a script (scripts/, bin/, tools/, ops/, jobs/ ...) writes
//                       production directly and stays R1-destructive, as does raw destructive SQL. Auth/RLS/grant SQL inside
//                       code is R2-sql-statement (blocking), never R2-auth
//   R4-config           what CI never runs: CLAUDE.md and other agent-instruction files, markdown under .github, local git
//                       hooks (.githooks, .husky; pre-commit / lefthook configs are core: CI often runs them), a newly
//                       ADDED plain package.json script (a new lifecycle script like pretest/postinstall/publish/pack/version
//                       runs implicitly, and every packageManager change is core, so those stay R4-pipeline)
// R5-major-dep IS eligible; its fail-closed "package.json could not be parsed" hit is emitted as R0-unscannable so it
// stays blocking. A rule named here that is outside the list is a config error, not a silent no-op, and classifyHardStops
// re-checks it (fail closed).
export const REPORT_ONLY_HARD_STOP_RULES = Object.freeze([
  'R1-data-write', 'R2-auth', 'R2-auth-removed', 'R3-secrets', 'R4-config', 'R5-major-dep', 'R6-sensitive', 'P-pattern',
]);

function checkReportOnlyRules(rules, disabled, errors) {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) return errors.push('hard_stops.report_only_rules must be an array');
  rules.forEach((r, i) => {
    if (!REPORT_ONLY_HARD_STOP_RULES.includes(r)) {
      errors.push(`hard_stops.report_only_rules[${i}]: ${JSON.stringify(r)} cannot be report-only (allowed: ${REPORT_ONLY_HARD_STOP_RULES.join(', ')})`);
    } else if (Array.isArray(disabled) && disabled.includes(r)) {
      errors.push(`hard_stops.report_only_rules[${i}]: ${JSON.stringify(r)} is also in hard_stops.disable_rules (pick one)`);
    }
  });
}

function checkPatterns(patterns, errors) {
  if (!Array.isArray(patterns)) return errors.push('hard_stops.patterns must be an array');
  patterns.forEach((item, i) => {
    const at = `hard_stops.patterns[${i}]`;
    if (!isObj(item)) return errors.push(`${at} must be a mapping with name and regex`);
    unknownKeys(item, KEYS.pattern, `${at}.`, errors);
    const label = isStr(item.name) ? `${at} "${item.name}"` : at;
    if (!isStr(item.name)) errors.push(`${at}.name is required (a non-empty string)`);
    if (!isStr(item.regex)) {
      errors.push(`${label}: regex is required (a non-empty string)`);
    } else {
      try {
        new RegExp(item.regex, 'i');
      } catch (err) {
        errors.push(`${label}: regex does not compile (${err.message})`);
      }
    }
    if (item.paths !== undefined && !isStrArray(item.paths)) errors.push(`${label}: paths must be an array of strings`);
  });
}

function checkSmokeChecks(checks, errors) {
  if (!Array.isArray(checks)) return errors.push('smoke_checks must be an array');
  checks.forEach((item, i) => {
    const at = `smoke_checks[${i}]`;
    if (!isObj(item)) return errors.push(`${at} must be a mapping with a path`);
    unknownKeys(item, KEYS.smoke, `${at}.`, errors);
    if (!isSmokePath(item.path)) errors.push(`${at}.path is required, must start with a single '/' (not '//') and contain no backslash or control character`);
    if (item.status !== undefined) {
      const ok = Array.isArray(item.status) && item.status.length > 0 && item.status.every((s) => inRange(s, 100, 599));
      if (!ok) errors.push(`${at}.status must be a non-empty array of integers 100..599`);
    }
    if (item.contains !== undefined && !isStrArray(item.contains)) errors.push(`${at}.contains must be an array of strings`);
    if (item.location_contains !== undefined && typeof item.location_contains !== 'string') {
      errors.push(`${at}.location_contains must be a string`);
    }
  });
}

/**
 * Validate a parsed pipeline.yml. Returns { ok, errors, warnings, config }.
 * config = DEFAULTS deep-merged with obj when ok; null when not ok (never hand out an invalid config).
 */
export function validateConfig(obj) {
  if (!isObj(obj)) return { ok: false, errors: ['pipeline.yml must be a mapping of settings'], config: null };
  const errors = [];
  const warnings = []; // advisories only: they never make a config invalid
  const config = merge(DEFAULTS, obj);

  unknownKeys(obj, KEYS.top, '', errors);
  // Checked on the raw input: the merged default would otherwise hide a missing version.
  if (obj.version !== 1) errors.push('version must be 1');
  if (!isStr(config.project)) errors.push('project is required (a non-empty string)');
  if (!['github', 'gate'].includes(config.enforcement)) errors.push('enforcement must be github|gate');
  if (!OWNER_APPROVALS.includes(config.owner_approval)) errors.push(`owner_approval must be ${OWNER_APPROVALS.join('|')}`);

  const ownerGo = section(config, 'owner_go', errors);
  if (ownerGo && !OWNER_GO_CLICKS.includes(ownerGo.click)) errors.push(`owner_go.click must be ${OWNER_GO_CLICKS.join('|')}`);

  const verify = section(config, 'verify', errors);
  if (verify) {
    if (!isStr(verify.full)) errors.push('verify.full is required (the full verify command)');
    if (!isStr(verify.quick)) errors.push('verify.quick is required (the quick verify command)');
    for (const k of ['report', 'screenshots']) if (!isStr(verify[k])) errors.push(`verify.${k} must be a non-empty string`);
    if (!inRange(verify.stop_queue_wait_minutes, 0, 30)) errors.push('verify.stop_queue_wait_minutes must be an integer 0..30');
    // Optional. When set, final-gate requires the verify report's step names to equal this list exactly, in order,
    // instead of trusting the list the report declares about itself.
    if (verify.expected_steps !== undefined) {
      const steps = verify.expected_steps;
      if (!Array.isArray(steps) || steps.length === 0 || !steps.every(isStr)) {
        errors.push('verify.expected_steps must be a non-empty array of non-empty step names');
      } else if (new Set(steps).size !== steps.length) {
        errors.push('verify.expected_steps must not repeat a step name');
      }
    }
    // Optional. The steps the owner allows verify to skip (a step skipped for a documented reason, e.g. a slow db step when no
    // dependency changed). final-gate refuses a skipped step that is not listed here; absent = no step may be skipped.
    if (verify.skippable_steps !== undefined) {
      const steps = verify.skippable_steps;
      if (!Array.isArray(steps) || !steps.every(isStr)) {
        errors.push('verify.skippable_steps must be an array of non-empty step names');
      } else if (new Set(steps).size !== steps.length) {
        errors.push('verify.skippable_steps must not repeat a step name');
      } else if (Array.isArray(verify.expected_steps)) {
        const unknown = steps.filter((n) => !verify.expected_steps.includes(n));
        if (unknown.length) errors.push(`verify.skippable_steps names step(s) not in verify.expected_steps: ${unknown.join(', ')}`);
      }
    }
    if (!AFTER_FIX_MODES.includes(verify.after_fix)) errors.push(`verify.after_fix must be ${AFTER_FIX_MODES.join('|')}`);
    checkAfterFix(verify, errors);
    checkSlots(verify, errors);
    checkCiProof(verify, errors);
  }

  const mergeSec = section(config, 'merge', errors);
  if (mergeSec) {
    if (!isStr(mergeSec.command)) errors.push('merge.command must be a non-empty string containing {pr} and {sha}');
    else {
      if (!mergeSec.command.includes('{pr}')) errors.push('merge.command must contain {pr} (the PR number)');
      if (!mergeSec.command.includes('{sha}')) {
        errors.push('merge.command must contain {sha} (the approved head SHA, so a moved head can never be merged)');
      }
    }
    if (!inRange(mergeSec.wait_minutes, 1, 120)) errors.push('merge.wait_minutes must be an integer 1..120');
    checkMergeHold(mergeSec, errors);
    if (!BEHIND_BASE_MODES.includes(mergeSec.behind_base)) errors.push(`merge.behind_base must be ${BEHIND_BASE_MODES.join('|')}`);
    const stale = mergeSec.behind_base_stale_paths;
    if (!Array.isArray(stale) || !stale.every(isStr)) errors.push('merge.behind_base_stale_paths must be an array of non-empty globs');
    else {
      for (const g of stale) {
        try {
          globToRegExp(g);
        } catch (err) {
          errors.push(`merge.behind_base_stale_paths[${JSON.stringify(g)}]: ${err.message}`);
        }
      }
    }
  }

  const review = section(config, 'review', errors);
  if (review) {
    if (!inRange(review.max_rounds, 1, 5)) errors.push('review.max_rounds must be an integer 1..5');
    checkPosInt(review.light_lane_max_lines, 'review.light_lane_max_lines', errors);
    checkStrArray(review.arbiter_always_paths, 'review.arbiter_always_paths', errors);
    if (!SIZE_ONLY_REVIEWERS.includes(review.size_only_medium_reviewer)) errors.push(`review.size_only_medium_reviewer must be one of ${SIZE_ONLY_REVIEWERS.join('|')}`);
    if (!isObj(review.effort)) errors.push('review.effort must be a mapping');
    else {
      for (const lane of Object.keys(review.effort)) {
        if (!EFFORT_LANES.includes(lane)) errors.push(`unknown key: review.effort.${lane} (lanes are ${EFFORT_LANES.join('|')})`);
        else if (!EFFORTS.includes(review.effort[lane])) errors.push(`review.effort.${lane} must be one of ${EFFORTS.join('|')}`);
      }
    }
  }

  const risk = section(config, 'risk', errors);
  if (risk) {
    checkStrArray(risk.high_risk_paths, 'risk.high_risk_paths', errors);
    checkIgnoreRules(risk.ignore_hard_stop_rules, errors);
    for (const k of ['medium_lines', 'high_lines', 'medium_files']) checkPosInt(risk[k], `risk.${k}`, errors);
    const pos = (v) => isInt(v) && v >= 1;
    if (pos(risk.medium_lines) && pos(risk.high_lines) && risk.medium_lines > risk.high_lines) {
      errors.push('risk.medium_lines must be <= risk.high_lines');
    }
    if (review && pos(risk.medium_lines) && pos(review.light_lane_max_lines) && review.light_lane_max_lines > risk.medium_lines) {
      errors.push('review.light_lane_max_lines must be <= risk.medium_lines');
    }
  }

  const wt = section(config, 'worktrees', errors);
  if (wt) {
    if (!['off', 'report', 'on'].includes(wt.mode)) errors.push('worktrees.mode must be one of off, report, on');
    for (const k of ['protect', 'delete', 'archive', 'memory_dirs']) checkStrArray(wt[k], `worktrees.${k}`, errors);
    for (const k of ['min_idle_hours', 'min_merged_hours']) checkPosInt(wt[k], `worktrees.${k}`, errors);
    if (isStrArray(wt.delete) && isStrArray(wt.archive)) {
      for (const p of wt.delete) if (wt.archive.includes(p)) errors.push(`worktrees: ${p} is in both delete and archive`);
    }
  }

  const hardStops = section(config, 'hard_stops', errors);
  if (hardStops) {
    checkStrArray(hardStops.paths, 'hard_stops.paths', errors);
    checkStrArray(hardStops.auth_calls, 'hard_stops.auth_calls', errors);
    checkPatterns(hardStops.patterns, errors);
    checkDisableRules(hardStops.disable_rules, errors);
    checkStrArray(hardStops.report_only_paths, 'hard_stops.report_only_paths', errors);
    checkReportOnlyRules(hardStops.report_only_rules, hardStops.disable_rules, errors);
  }

  const integrity = section(config, 'integrity', errors);
  if (integrity) checkStrArray(integrity.test_globs, 'integrity.test_globs', errors);
  if (review) checkDocsExempt(config, errors); // after the lists it compares against

  const ci = section(config, 'ci', errors);
  if (ci) {
    checkStrArray(ci.required_checks, 'ci.required_checks', errors);
    if (ci.e2e_label !== null && typeof ci.e2e_label !== 'string') errors.push('ci.e2e_label must be a string or null');
    if (typeof ci.draft_while_iterating !== 'boolean') errors.push('ci.draft_while_iterating must be a boolean');
    if (!Array.isArray(ci.approvers) || !ci.approvers.every((l) => typeof l === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(l))) {
      errors.push('ci.approvers must be an array of GitHub logins');
    }
    if (typeof ci.guard_checks !== 'boolean') errors.push('ci.guard_checks must be a boolean');
    else if (ci.guard_checks && isStrArray(ci.required_checks)) {
      const missing = GUARD_CHECKS.filter((g) => !ci.required_checks.includes(g));
      if (missing.length > 0) {
        warnings.push(`ci.required_checks does not list ${missing.map((m) => JSON.stringify(m)).join(' and ')}: they are required anyway (ci.guard_checks); list them so the config matches branch protection, or set ci.guard_checks: false if this repo does not run pipeline-guards.yml`);
      }
    }
    if (typeof ci.review_check !== 'boolean') errors.push('ci.review_check must be a boolean');
    // The review status comes from the guards workflow: without it nothing would ever post the check every merge waits for.
    else if (ci.review_check && ci.guard_checks === false) errors.push('ci.review_check needs ci.guard_checks: the Cross-model review status is posted by pipeline-guards.yml');
  }

  if (config.preview !== null) checkPreview(config.preview, errors);
  if (config.production !== null) checkProduction(config.production, errors);
  checkSmokeChecks(config.smoke_checks, errors);
  if (config.smoke_bypass_header !== null && !(typeof config.smoke_bypass_header === 'string' && SMOKE_BYPASS_HEADER_RE.test(config.smoke_bypass_header))) {
    errors.push('smoke_bypass_header must be null or a lowercase header name matching /^x-[a-z0-9-]{1,60}$/ (e.g. x-smoke-key); the secret value belongs in the PIPELINE_SMOKE_BYPASS_KEY environment variable, not in this file');
  }
  const origins = config.smoke_bypass_origins;
  if (!Array.isArray(origins) || !origins.every(isSmokeBypassOrigin)) {
    errors.push('smoke_bypass_origins must be an array of https origins exactly as written by new URL(x).origin, e.g. "https://www.example.com" (no path, trailing slash, query, fragment, credentials or default port)');
  } else if (config.smoke_bypass_header !== null && origins.length === 0) {
    errors.push('smoke_bypass_origins must list at least one https origin when smoke_bypass_header is set: the header is only ever sent to a listed origin');
  }

  return errors.length === 0 ? { ok: true, errors, warnings, config } : { ok: false, errors, warnings, config: null };
}

// The retired Stop hook's own timeout (seconds), and the part of it stop-verify spent executing. Kept for a project that still has the hook.
const STOP_HOOK_TIMEOUT_S = 900;

/**
 * Advisory for verify.stop_queue_wait_minutes > 0: the Stop hook entry in .claude/settings.json that runs stop-verify must
 * time out no earlier than 900 s + the allowance, or Claude Code kills the hook while verify.quick is still queued.
 * settingsText is the file's text (null = missing). Returns a warning string, or null when there is nothing to say; a
 * missing, unreadable or odd-shaped settings file, or a hook with no numeric timeout, never warns.
 */
export function stopHookTimeoutWarning(config, settingsText) {
  const minutes = config?.verify?.stop_queue_wait_minutes;
  if (!isInt(minutes) || minutes <= 0 || typeof settingsText !== 'string') return null;
  let settings;
  try { settings = JSON.parse(settingsText); } catch { return null; }
  const groups = settings?.hooks?.Stop;
  if (!Array.isArray(groups)) return null;
  const needed = STOP_HOOK_TIMEOUT_S + minutes * 60;
  for (const group of groups) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (typeof hook?.command !== 'string' || !hook.command.includes('stop-verify')) continue;
      if (typeof hook.timeout === 'number' && hook.timeout < needed) {
        return `verify.stop_queue_wait_minutes: ${minutes} needs the Stop hook timeout in .claude/settings.json to be at least ${needed} s (${STOP_HOOK_TIMEOUT_S} + ${minutes} * 60), but the stop-verify hook has ${hook.timeout} s: Claude Code would kill it while verify.quick is still queued`;
      }
    }
  }
  return null;
}

// The config as the base side (the PR's fork point) has it: { ok: true, config } | { ok: false, reason }. A PR must not loosen its own rules, so
// the rating (risk.mjs#rateBranch), the Fable brief choice (arbiter) and the final gate read the committed copy too. Moved here from arbiter.mjs.
export function baseConfigAt(forkPoint, root) {
  const msgOf = (err) => String(err?.message ?? err).split('\n')[0];
  if (typeof forkPoint !== 'string' || forkPoint === '') return { ok: false, reason: 'the round records no fork point' };
  let text;
  try {
    text = showFile(forkPoint, '.claude/pipeline.yml', { cwd: root });
  } catch (err) {
    return { ok: false, reason: `could not read .claude/pipeline.yml at the fork point: ${msgOf(err)}` };
  }
  if (text === null) return { ok: false, reason: 'the fork point has no .claude/pipeline.yml' };
  let parsed;
  try {
    parsed = validateConfig(parseYaml(text));
  } catch (err) {
    return { ok: false, reason: `the fork point's .claude/pipeline.yml cannot be parsed: ${msgOf(err)}` };
  }
  if (!parsed.ok) return { ok: false, reason: `the fork point's .claude/pipeline.yml is not a valid config: ${parsed.errors.slice(0, 2).join('; ')}` };
  return { ok: true, config: parsed.config };
}

/** Read <repoDir>/.claude/pipeline.yml and validate it. IO is injectable for tests. */
export async function loadConfig(repoDir, { readFile = fs.promises.readFile } = {}) {
  const file = path.join(repoDir, '.claude', 'pipeline.yml');
  let text;
  try {
    text = String(await readFile(file, 'utf8'));
  } catch (err) {
    const errors = err?.code === 'ENOENT' ? ['missing .claude/pipeline.yml'] : [`cannot read ${file}: ${err?.message ?? err}`];
    return { ok: false, errors, config: null, path: file };
  }
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return { ok: false, errors: [err.message], config: null, path: file };
  }
  const result = validateConfig(parsed);
  if (result.ok && result.config.verify.stop_queue_wait_minutes > 0) {
    let settingsText = null;
    try { settingsText = String(await readFile(path.join(repoDir, '.claude', 'settings.json'), 'utf8')); } catch { /* no settings: nothing to compare */ }
    const warning = stopHookTimeoutWarning(result.config, settingsText);
    if (warning) result.warnings.push(warning);
  }
  return { ...result, path: file };
}

/**
 * Replace {name} with vars[name] (stringified) for names present in vars; unknown {x} stay untouched.
 * strict: throw instead if any placeholder in the template has no value (missing, undefined, null or blank) -
 * use it whenever the result becomes a shell command, so a missing {sha} can never silently become a bad command.
 * A {name} immediately preceded by $ is a shell ${VAR}, not a placeholder: it is left untouched and never counted as missing.
 */
export function fill(template, vars, { strict = false } = {}) {
  const text = String(template);
  const re = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  if (strict) {
    const missing = new Set();
    for (const [, name] of text.matchAll(re)) {
      const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
      if (v === undefined || v === null || String(v).trim() === '') missing.add(name);
    }
    if (missing.size > 0) throw new Error(`fill: no value for ${[...missing].map((n) => `{${n}}`).join(', ')}`);
  }
  // Replacer function (not a replacement string) so "$&" / "$1" in a value are never interpreted.
  return text.replace(re, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}
