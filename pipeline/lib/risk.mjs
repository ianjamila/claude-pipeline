// Risk level of a PR: how much human attention it deserves, and whether it qualifies for the light review lane.
// Why a pure function over (files, hits, config): the level decides the review effort and the E2E label, so it must be
// reproducible from the same inputs locally and in CI. A hard-stop hit that blocks (or that the owner must approve in chat,
// `ownerMerge`) is `high` by definition; a report-only (advisory) hit only raises to `medium`: it was downgraded on purpose,
// so it must not cost a PR the high-risk review on its own. Size and risky paths only add to that. Path matching tests the
// old AND new path (a rename out of a risky dir is still a change to it) with nocase, so a case-only difference can never
// hide a risky path on a case-folding filesystem.
// Bad inputs throw TypeError: a `hits` that is not an array (a forgotten await gives a Promise) or a threshold that is
// not a finite number (a string compares wrongly, NaN never trips) must never quietly downgrade a PR to "low".
import { diffStats } from './diff.mjs';
import { matchAny } from './glob.mjs';
import { DEFAULTS, RISK_IGNORABLE_RULES } from './config.mjs';

const LEVELS = ['low', 'medium', 'high'];
export const SIZE_ONLY_NOTE = 'medium for size only: Sonnet judge (review.size_only_medium_reviewer)';
const matches = (p, globs) => matchAny(p, globs, { nocase: true });

// A threshold: the config value when given, the default when absent (undefined), a TypeError when present but not finite.
function number(section, key, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${section}.${key} must be a finite number (got ${String(value)})`);
  return value;
}

// Globs from a config list (the default when absent), or a TypeError when the list is not an array of strings.
function globList(value, name, fallback) {
  const globs = value ?? fallback;
  if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string')) throw new TypeError(`${name} must be an array of strings`);
  return globs;
}

// Every path a file change touches: a rename counts for its old AND new path.
const pathsOf = (f) => [...new Set([f.oldPath, f.newPath, f.path].filter(Boolean))];
const shownPath = (f) => f.path ?? f.newPath ?? f.oldPath;
const listed = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`;

function thresholds(config) {
  const r = config?.risk ?? {};
  return {
    high_risk_paths: globList(r.high_risk_paths, 'risk.high_risk_paths', DEFAULTS.risk.high_risk_paths),
    medium_lines: number('risk', 'medium_lines', r.medium_lines, DEFAULTS.risk.medium_lines),
    high_lines: number('risk', 'high_lines', r.high_lines, DEFAULTS.risk.high_lines),
    medium_files: number('risk', 'medium_files', r.medium_files, DEFAULTS.risk.medium_files),
  };
}

// risk.ignore_hard_stop_rules: hits of these rules do not count toward the level. Only the allowlisted rules are honoured, whatever the config
// says (config validation refuses the rest; this is the second line of defence), and a list that is not an array of strings is a TypeError.
// The self-lowering guard: a PR that edits the config that rates it (adds an ignore rule, drops a high-risk path) changes .claude/pipeline.yml,
// which is an R4-pipeline hit (never ignorable) and so high; and rateBranch also rates under the base branch's committed config, stricter wins.
function ignoredRules(config) {
  const rules = globList(config?.risk?.ignore_hard_stop_rules, 'risk.ignore_hard_stop_rules', DEFAULTS.risk.ignore_hard_stop_rules);
  return rules.filter((r) => RISK_IGNORABLE_RULES.includes(r));
}

// The hits that count toward the risk level: all of them except the rules risk.ignore_hard_stop_rules lists. Everything else (the hit list, the
// owner-merge items, the final gate, the light lane) keeps using the raw list.
export function riskHits(hits, config) {
  if (!Array.isArray(hits)) throw new TypeError('riskHits: hits must be an array');
  const ignored = ignoredRules(config);
  return ignored.length === 0 ? [...hits] : hits.filter((h) => !ignored.includes(h?.rule));
}

// { level: 'low'|'medium'|'high', reasons[], changedLines, fileCount, drivers: {hardStop, advisory, path, size}, sizeOnly }
// sizeOnly: the level is medium, size is the only thing that raised it, and the raw hit list is empty (an ignored, report-only or R0 hit all make it false).
export function assessRisk({ files, hits, config }) {
  if (!Array.isArray(files)) throw new TypeError('assessRisk: files must be an array');
  if (!Array.isArray(hits)) throw new TypeError('assessRisk: hits must be an array');
  const risk = thresholds(config);
  const { changedLines } = diffStats(files);
  const fileCount = files.length;
  const reasons = [];
  let level = 'low';
  const raise = (to) => {
    if (to === 'high' || level === 'low') level = to;
  };

  // A hit without `advisory: true` blocks (hardstops.mjs#blockingHits). An ownerMerge hit is advisory only because the owner
  // approves it in chat instead of by label, so it weighs as much as a blocking one. Anything that is not exactly a
  // report-only hit counts as heavy: a malformed entry must never lower the level.
  const isReportOnly = (h) => h?.advisory === true && h.ownerMerge !== true;
  const rules = (list) => [...new Set(list.map((h) => h?.rule))].join(', ');
  const counted = riskHits(hits, config);
  const heavy = counted.filter((h) => !isReportOnly(h));
  const reportOnly = counted.filter(isReportOnly);
  if (heavy.length > 0) {
    raise('high');
    reasons.push(`hard-stop: ${rules(heavy)}`);
  }
  if (reportOnly.length > 0) {
    raise('medium');
    reasons.push(`advisory hard-stop: ${rules(reportOnly)}`);
  }

  const riskyPaths = files.filter((f) => pathsOf(f).some((p) => matches(p, risk.high_risk_paths))).map(shownPath);
  if (riskyPaths.length > 0) {
    raise('high');
    reasons.push(`high-risk path: ${listed(riskyPaths)}`);
  }

  let size = false;
  if (changedLines > risk.high_lines) {
    raise('high');
    size = true;
    reasons.push(`${changedLines} changed lines > ${risk.high_lines}`);
  } else if (changedLines > risk.medium_lines) {
    raise('medium');
    size = true;
    reasons.push(`${changedLines} changed lines > ${risk.medium_lines}`);
  }

  if (fileCount > risk.medium_files) {
    raise('medium');
    size = true;
    reasons.push(`${fileCount} files > ${risk.medium_files}`);
  }

  if (reasons.length === 0) reasons.push('small change');
  // Said out loud, so the report never hides that hits were discounted.
  const discounted = hits.filter((h) => !counted.includes(h));
  if (discounted.length > 0) reasons.push(`ignored hard-stop rules: ${rules(discounted)} (risk.ignore_hard_stop_rules)`);
  const drivers = { hardStop: heavy.length > 0, advisory: reportOnly.length > 0, path: riskyPaths.length > 0, size };
  const sizeOnly = level === 'medium' && size && hits.length === 0 && riskyPaths.length === 0;
  return { level, reasons, changedLines, fileCount, drivers, sizeOnly };
}

// The light lane skips the arbiter, so it is only for changes that are low risk, hit nothing, and are small.
export function isLightLane({ level, changedLines, hits, config }) {
  if (!LEVELS.includes(level)) throw new TypeError(`isLightLane: level must be one of ${LEVELS.join('|')}`);
  if (typeof changedLines !== 'number' || !Number.isFinite(changedLines)) throw new TypeError('isLightLane: changedLines must be a finite number');
  if (!Array.isArray(hits)) throw new TypeError('isLightLane: hits must be an array');
  const cap = number('review', 'light_lane_max_lines', config?.review?.light_lane_max_lines, DEFAULTS.review.light_lane_max_lines);
  return level === 'low' && hits.length === 0 && changedLines < cap;
}

// Is this changed file (one entry of diffFiles) on a sensitive path: risk.high_risk_paths or review.arbiter_always_paths, old OR new path, matched
// like reviewLane does. Throws a TypeError for a config list that is not an array of strings (the callers fail closed on it).
export function isSensitivePath(file, config) {
  const { high_risk_paths: highRisk } = thresholds(config);
  const always = globList(config?.review?.arbiter_always_paths, 'review.arbiter_always_paths', DEFAULTS.review.arbiter_always_paths);
  return pathsOf(file).some((p) => matches(p, highRisk) || matches(p, always));
}

// Which reviewer follows Codex. `fable`: one Fable pass per round that rules on every Codex item AND reviews the diff itself
// (agents/arbiter.md), for a medium or high PR or one touching a sensitive path (risk.high_risk_paths or
// review.arbiter_always_paths, matched like high_risk_paths). `judge`: the Sonnet judge, for everything else.
// A medium PR whose level came from its size alone (`sizeOnly`, assessRisk) with no sensitive path goes to the judge too, unless
// review.size_only_medium_reviewer is 'fable'. A missing or false sizeOnly keeps Fable (fail toward the stronger reviewer).
// -> { reviewer: 'fable'|'judge', reasons[], sensitivePaths[], sizeOnlyJudge?: true, note?: string }; sensitivePaths also gets Codex its attacker's brief.
export function reviewLane({ level, files, config, sizeOnly = false }) {
  if (!LEVELS.includes(level)) throw new TypeError(`reviewLane: level must be one of ${LEVELS.join('|')}`);
  if (!Array.isArray(files)) throw new TypeError('reviewLane: files must be an array');
  const { high_risk_paths: highRisk } = thresholds(config);
  const always = globList(config?.review?.arbiter_always_paths, 'review.arbiter_always_paths', DEFAULTS.review.arbiter_always_paths);
  const sensitivePaths = files.filter((f) => pathsOf(f).some((p) => matches(p, highRisk) || matches(p, always))).map(shownPath);
  const reasons = [];
  const preference = config?.review?.size_only_medium_reviewer ?? DEFAULTS.review.size_only_medium_reviewer;
  if (level === 'medium' && sizeOnly === true && sensitivePaths.length === 0 && preference === 'judge') {
    return { reviewer: 'judge', reasons, sensitivePaths, sizeOnlyJudge: true, note: SIZE_ONLY_NOTE };
  }
  if (level !== 'low') reasons.push(`${level} risk`);
  if (sensitivePaths.length > 0) reasons.push(`sensitive path: ${listed(sensitivePaths)}`);
  return { reviewer: reasons.length > 0 ? 'fable' : 'judge', reasons, sensitivePaths };
}
