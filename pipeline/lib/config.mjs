// Loads and validates a project's .claude/pipeline.yml. Every other pipeline module reads config through here,
// so a typo or a missing field fails loudly up front (all errors at once) instead of mid-pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

export const DEFAULTS = {
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
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const PROVIDERS = ['vercel', 'github-deployments', 'other'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// Arrays replace, plain objects merge, everything else (incl. null) replaces. Always returns fresh copies so
// callers can mutate the result without touching DEFAULTS or the parsed input.
function merge(base, over) {
  if (over === undefined) return structuredClone(base);
  if (isObj(base) && isObj(over)) {
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over[k]);
    for (const k of Object.keys(over)) if (!(k in base)) out[k] = structuredClone(over[k]);
    return out;
  }
  return structuredClone(over);
}

// Reads a nested mapping; records an error (once) and returns {} if it is present but not a mapping.
function mapping(obj, key, errors) {
  const v = obj[key];
  if (isObj(v)) return v;
  errors.push(`${key} must be a mapping`);
  return {};
}

function checkStrArray(value, name, errors) {
  if (!isStrArray(value)) errors.push(`${name} must be an array of strings`);
}

function checkUrlTemplate(value, name, errors) {
  if (!isStr(value)) errors.push(`${name} is required (a non-empty string containing {url})`);
  else if (!value.includes('{url}')) errors.push(`${name} must contain {url}`);
}

function checkPreview(p, errors) {
  if (!isObj(p)) return errors.push('preview must be null or a mapping');
  if (!isStr(p.environment)) errors.push('preview.environment is required (a non-empty string)');
  checkUrlTemplate(p.smoke, 'preview.smoke', errors);
  if (p.provider === undefined) p.provider = 'github-deployments';
  else if (!isStr(p.provider)) errors.push('preview.provider must be a string');
}

function checkProduction(p, errors) {
  if (!isObj(p)) return errors.push('production must be null or a mapping');
  if (!isStr(p.url) || !/^https:\/\/\S+$/.test(p.url)) errors.push('production.url is required and must be an https URL');
  if (!isStr(p.environment)) errors.push('production.environment is required (a non-empty string)');
  checkUrlTemplate(p.smoke, 'production.smoke', errors);
  if (!isObj(p.rollback) || !isStr(p.rollback.command)) {
    errors.push('production.rollback.command is required (a non-empty string)');
  } else if (p.rollback.notes !== undefined && typeof p.rollback.notes !== 'string') {
    errors.push('production.rollback.notes must be a string');
  }
  if (p.provider === undefined) p.provider = 'github-deployments';
  else if (!PROVIDERS.includes(p.provider)) errors.push(`production.provider must be one of ${PROVIDERS.join('|')}`);
  if (p.deploy_timeout_minutes === undefined) p.deploy_timeout_minutes = 20;
  else if (!isInt(p.deploy_timeout_minutes) || p.deploy_timeout_minutes < 1 || p.deploy_timeout_minutes > 120) {
    errors.push('production.deploy_timeout_minutes must be an integer 1..120');
  }
}

function checkPatterns(patterns, errors) {
  if (!Array.isArray(patterns)) return errors.push('hard_stops.patterns must be an array');
  patterns.forEach((item, i) => {
    const at = `hard_stops.patterns[${i}]`;
    if (!isObj(item)) return errors.push(`${at} must be a mapping with name and regex`);
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
    if (typeof item.path !== 'string' || !item.path.startsWith('/')) errors.push(`${at}.path is required and must start with '/'`);
    if (item.status !== undefined && !(Array.isArray(item.status) && item.status.every(isInt))) {
      errors.push(`${at}.status must be an array of integers`);
    }
    if (item.contains !== undefined && !isStrArray(item.contains)) errors.push(`${at}.contains must be an array of strings`);
    if (item.location_contains !== undefined && typeof item.location_contains !== 'string') {
      errors.push(`${at}.location_contains must be a string`);
    }
  });
}

/** Validate a parsed pipeline.yml. Returns { ok, errors, config } where config = DEFAULTS deep-merged with obj. */
export function validateConfig(obj) {
  if (!isObj(obj)) return { ok: false, errors: ['pipeline.yml must be a mapping of settings'], config: null };
  const errors = [];
  const config = merge(DEFAULTS, obj);

  for (const k of Object.keys(obj)) if (!(k in DEFAULTS) && k !== 'project') errors.push(`unknown key: ${k}`);

  // Checked on the raw input: the merged default would otherwise hide a missing version.
  if (obj.version !== 1) errors.push('version must be 1');
  if (!isStr(config.project)) errors.push('project is required (a non-empty string)');
  if (!['github', 'gate'].includes(config.enforcement)) errors.push('enforcement must be github|gate');

  const verify = mapping(config, 'verify', errors);
  if (!isStr(verify.full)) errors.push('verify.full is required (the full verify command)');
  if (!isStr(verify.quick)) errors.push('verify.quick is required (the quick verify command)');

  const merge_ = mapping(config, 'merge', errors);
  if (!isStr(merge_.command)) errors.push('merge.command must be a non-empty string containing {pr} and {sha}');
  else {
    if (!merge_.command.includes('{pr}')) errors.push('merge.command must contain {pr} (the PR number)');
    if (!merge_.command.includes('{sha}')) {
      errors.push('merge.command must contain {sha} (the approved head SHA, so a moved head can never be merged)');
    }
  }

  const review = mapping(config, 'review', errors);
  if (!isInt(review.max_rounds) || review.max_rounds < 1 || review.max_rounds > 5) {
    errors.push('review.max_rounds must be an integer 1..5');
  }
  if (!isObj(review.effort)) errors.push('review.effort must be a mapping');
  else {
    for (const [lane, v] of Object.entries(review.effort)) {
      if (!EFFORTS.includes(v)) errors.push(`review.effort.${lane} must be one of ${EFFORTS.join('|')}`);
    }
  }

  if (config.preview !== null) checkPreview(config.preview, errors);
  if (config.production !== null) checkProduction(config.production, errors);

  checkStrArray(mapping(config, 'hard_stops', errors).paths, 'hard_stops.paths', errors);
  checkStrArray(config.hard_stops?.auth_calls, 'hard_stops.auth_calls', errors);
  checkPatterns(config.hard_stops?.patterns, errors);
  checkStrArray(mapping(config, 'risk', errors).high_risk_paths, 'risk.high_risk_paths', errors);
  checkStrArray(mapping(config, 'integrity', errors).test_globs, 'integrity.test_globs', errors);
  checkStrArray(mapping(config, 'ci', errors).required_checks, 'ci.required_checks', errors);
  checkSmokeChecks(config.smoke_checks, errors);

  return { ok: errors.length === 0, errors, config };
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

/** Replace {name} with vars[name] (stringified) for names present in vars; unknown {x} stay untouched. */
export function fill(template, vars) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}
