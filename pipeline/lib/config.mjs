// Loads and validates a project's .claude/pipeline.yml. Every other pipeline module reads config through here,
// so a typo or a missing field fails loudly up front (all errors at once) instead of mid-pipeline.
// Fail-closed by design: unknown keys are rejected at every level, numbers are range-checked, and an invalid
// config is never returned (config: null), so nothing can accidentally run on a half-valid one.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { globToRegExp } from './glob.mjs';

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
  // owner adds human-approved / test-change-approved; 'chat' = no label and CI does not fail on those: the ship skill stops
  // before the merge, asks in chat, and runs the merge when the owner says "merge".
  owner_approval: 'label',
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
  // stop_queue_wait_minutes: how long verify.quick may WAIT (for a machine-wide heavy-check slot) before it runs, on top of the
  // Stop hook's own 840 s execution allowance. 0 = no queue. The hook's timeout in .claude/settings.json must grow to match.
  // after_fix: what the verifier runs after review fixes are accepted: 'full' (today) or 'quick' (see `pipeline verify plan-after-fix`).
  verify: { report: '.verify/report.json', screenshots: '.verify/screenshots', stop_queue_wait_minutes: 0, after_fix: 'full' },
  // guard_checks: the tamper-proof "Test integrity" and "Hard-stop scan" statuses are always required on top of
  // required_checks. false only for a repo that does not run the pipeline-guards workflow (e.g. this one).
  // approvers: GitHub logins whose approval labels (human-approved, test-change-approved) count. Empty = the repo owner,
  // which only exists for user-owned repos: an org-owned repo MUST list its approvers.
  ci: { required_checks: [], e2e_label: null, draft_while_iterating: false, guard_checks: true, approvers: [] },
  // {sha} is required: the approved head is passed to the merge so a head that moved after review can never merge.
  merge: { command: 'gh pr merge {pr} --squash --auto --delete-branch --match-head-commit {sha}', wait_minutes: 15 },
  preview: null,
  production: null,
  smoke_checks: [],
  risk: { high_risk_paths: [], medium_lines: 150, high_lines: 600, medium_files: 10 },
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
    max_rounds: 3,
    light_lane_max_lines: 50,
  },
  agent_log: 'docs/agent-log.md',
});

// The two required statuses pipeline-guards.yml posts (templates/scripts/pipeline/ci-guards-run.mjs CONTEXTS).
export const GUARD_CHECKS = Object.freeze(['Test integrity', 'Hard-stop scan']);

// Every status context branch protection must require: what the project lists plus, unless ci.guard_checks is false, the
// two guard contexts. Without them a repo that lists no checks would read as "protected" with nothing required at all.
export function requiredChecks(ci) {
  const configured = Array.isArray(ci?.required_checks) ? ci.required_checks : [];
  const guards = ci?.guard_checks === false ? [] : GUARD_CHECKS;
  return [...new Set([...configured, ...guards])];
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LANES = ['low', 'medium', 'high', 'followup'];
const OWNER_APPROVALS = ['label', 'chat'];
const PROVIDERS = ['vercel', 'github-deployments', 'other'];
// Who owns the production smoke: the ship session (prod-watch) or a CI workflow that posts the result on the merged PR.
const WATCH_MODES = ['session', 'workflow'];
const AFTER_FIX_MODES = ['full', 'quick'];

// Allowed keys per mapping. Anything else is a typo (or a removed option) and is rejected.
const KEYS = {
  top: [...Object.keys(DEFAULTS), 'project'],
  worktrees: ['mode', 'protect', 'min_idle_hours', 'min_merged_hours', 'delete', 'archive', 'memory_dirs'],
  verify: ['full', 'quick', 'report', 'screenshots', 'expected_steps', 'skippable_steps', 'stop_queue_wait_minutes', 'after_fix', 'after_fix_steps_by_path', 'after_fix_never'],
  ci: ['required_checks', 'e2e_label', 'draft_while_iterating', 'guard_checks', 'approvers'],
  merge: ['command', 'wait_minutes'],
  preview: ['environment', 'smoke', 'provider'],
  production: ['url', 'provider', 'environment', 'smoke', 'deploy_timeout_minutes', 'rollback', 'watch'],
  rollback: ['command', 'notes'],
  risk: ['high_risk_paths', 'medium_lines', 'high_lines', 'medium_files'],
  hard_stops: ['paths', 'patterns', 'auth_calls', 'disable_rules', 'report_only_rules', 'report_only_paths'],
  pattern: ['name', 'regex', 'paths'],
  integrity: ['test_globs'],
  review: ['codex_model', 'effort', 'max_rounds', 'light_lane_max_lines'],
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
    if (typeof item.path !== 'string' || !item.path.startsWith('/')) errors.push(`${at}.path is required and must start with '/'`);
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
  }

  const review = section(config, 'review', errors);
  if (review) {
    if (!inRange(review.max_rounds, 1, 5)) errors.push('review.max_rounds must be an integer 1..5');
    checkPosInt(review.light_lane_max_lines, 'review.light_lane_max_lines', errors);
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
  }

  if (config.preview !== null) checkPreview(config.preview, errors);
  if (config.production !== null) checkProduction(config.production, errors);
  checkSmokeChecks(config.smoke_checks, errors);

  return errors.length === 0 ? { ok: true, errors, warnings, config } : { ok: false, errors, warnings, config: null };
}

// The Stop hook's own timeout (seconds) in the template settings.json, and the part of it stop-verify spends executing.
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
