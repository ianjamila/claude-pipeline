// Loads and validates a project's .claude/pipeline.yml. Every other pipeline module reads config through here,
// so a typo or a missing field fails loudly up front (all errors at once) instead of mid-pipeline.
// Fail-closed by design: unknown keys are rejected at every level, numbers are range-checked, and an invalid
// config is never returned (config: null), so nothing can accidentally run on a half-valid one.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

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
  default_branch: 'main',
  worktree_dir: '.worktrees',
  verify: { report: '.verify/report.json', screenshots: '.verify/screenshots' },
  ci: { required_checks: [], e2e_label: null, draft_while_iterating: false },
  // {sha} is required: the approved head is passed to the merge so a head that moved after review can never merge.
  merge: { command: 'gh pr merge {pr} --squash --auto --delete-branch --match-head-commit {sha}', wait_minutes: 15 },
  preview: null,
  production: null,
  smoke_checks: [],
  risk: { high_risk_paths: [], medium_lines: 150, high_lines: 600, medium_files: 10 },
  hard_stops: { paths: [], patterns: [], auth_calls: [] },
  integrity: {
    test_globs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', 'e2e/**', 'supabase/tests/**'],
  },
  review: {
    codex_model: 'gpt-6-astra',
    effort: { low: 'medium', medium: 'medium', high: 'high', followup: 'medium' },
    max_rounds: 3,
    light_lane_max_lines: 50,
  },
  agent_log: 'docs/agent-log.md',
});

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LANES = ['low', 'medium', 'high', 'followup'];
const PROVIDERS = ['vercel', 'github-deployments', 'other'];

// Allowed keys per mapping. Anything else is a typo (or a removed option) and is rejected.
const KEYS = {
  top: [...Object.keys(DEFAULTS), 'project'],
  verify: ['full', 'quick', 'report', 'screenshots'],
  ci: ['required_checks', 'e2e_label', 'draft_while_iterating'],
  merge: ['command', 'wait_minutes'],
  preview: ['environment', 'smoke', 'provider'],
  production: ['url', 'provider', 'environment', 'smoke', 'deploy_timeout_minutes', 'rollback'],
  rollback: ['command', 'notes'],
  risk: ['high_risk_paths', 'medium_lines', 'high_lines', 'medium_files'],
  hard_stops: ['paths', 'patterns', 'auth_calls'],
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

function checkNonNegInt(value, name, errors) {
  if (!isInt(value) || value < 0) errors.push(`${name} must be a non-negative integer`);
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
 * Validate a parsed pipeline.yml. Returns { ok, errors, config }.
 * config = DEFAULTS deep-merged with obj when ok; null when not ok (never hand out an invalid config).
 */
export function validateConfig(obj) {
  if (!isObj(obj)) return { ok: false, errors: ['pipeline.yml must be a mapping of settings'], config: null };
  const errors = [];
  const config = merge(DEFAULTS, obj);

  unknownKeys(obj, KEYS.top, '', errors);
  // Checked on the raw input: the merged default would otherwise hide a missing version.
  if (obj.version !== 1) errors.push('version must be 1');
  if (!isStr(config.project)) errors.push('project is required (a non-empty string)');
  if (!['github', 'gate'].includes(config.enforcement)) errors.push('enforcement must be github|gate');

  const verify = section(config, 'verify', errors);
  if (verify) {
    if (!isStr(verify.full)) errors.push('verify.full is required (the full verify command)');
    if (!isStr(verify.quick)) errors.push('verify.quick is required (the quick verify command)');
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
    checkNonNegInt(review.light_lane_max_lines, 'review.light_lane_max_lines', errors);
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
    for (const k of ['medium_lines', 'high_lines', 'medium_files']) checkNonNegInt(risk[k], `risk.${k}`, errors);
    const nonNeg = (v) => isInt(v) && v >= 0;
    if (nonNeg(risk.medium_lines) && nonNeg(risk.high_lines) && risk.medium_lines > risk.high_lines) {
      errors.push('risk.medium_lines must be <= risk.high_lines');
    }
    if (review && nonNeg(risk.medium_lines) && nonNeg(review.light_lane_max_lines) && review.light_lane_max_lines > risk.medium_lines) {
      errors.push('review.light_lane_max_lines must be <= risk.medium_lines');
    }
  }

  const hardStops = section(config, 'hard_stops', errors);
  if (hardStops) {
    checkStrArray(hardStops.paths, 'hard_stops.paths', errors);
    checkStrArray(hardStops.auth_calls, 'hard_stops.auth_calls', errors);
    checkPatterns(hardStops.patterns, errors);
  }

  const integrity = section(config, 'integrity', errors);
  if (integrity) checkStrArray(integrity.test_globs, 'integrity.test_globs', errors);

  const ci = section(config, 'ci', errors);
  if (ci) checkStrArray(ci.required_checks, 'ci.required_checks', errors);

  if (config.preview !== null) checkPreview(config.preview, errors);
  if (config.production !== null) checkProduction(config.production, errors);
  checkSmokeChecks(config.smoke_checks, errors);

  return errors.length === 0 ? { ok: true, errors, config } : { ok: false, errors, config: null };
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
  return { ...validateConfig(parsed), path: file };
}

/**
 * Replace {name} with vars[name] (stringified) for names present in vars; unknown {x} stay untouched.
 * strict: throw instead if any placeholder in the template has no value (missing, undefined, null or blank) -
 * use it whenever the result becomes a shell command, so a missing {sha} can never silently become a bad command.
 * Note strict treats every {identifier} as a placeholder, including the braces of a shell ${VAR}.
 */
export function fill(template, vars, { strict = false } = {}) {
  const text = String(template);
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
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
