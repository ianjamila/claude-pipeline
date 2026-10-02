// Risk level of a PR: how much human attention it deserves, and whether it qualifies for the light review lane.
// Why a pure function over (files, hits, config): the level decides the review effort and the E2E label, so it must be
// reproducible from the same inputs locally and in CI. Anything a hard-stop flagged is `high` by definition; size and
// risky paths only add to that. Path matching tests the old AND new path (a rename out of a risky dir is still a change
// to it) with nocase, so a case-only difference can never hide a risky path on a case-folding filesystem.
// Bad inputs throw TypeError: a `hits` that is not an array (a forgotten await gives a Promise) or a threshold that is
// not a finite number (a string compares wrongly, NaN never trips) must never quietly downgrade a PR to "low".
import { diffStats } from './diff.mjs';
import { matchAny } from './glob.mjs';
import { DEFAULTS } from './config.mjs';

const LEVELS = ['low', 'medium', 'high'];
const matches = (p, globs) => matchAny(p, globs, { nocase: true });

// A threshold: the config value when given, the default when absent (undefined), a TypeError when present but not finite.
function number(section, key, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${section}.${key} must be a finite number (got ${String(value)})`);
  return value;
}

function thresholds(config) {
  const r = config?.risk ?? {};
  const globs = r.high_risk_paths ?? DEFAULTS.risk.high_risk_paths;
  if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string')) throw new TypeError('risk.high_risk_paths must be an array of strings');
  return {
    high_risk_paths: globs,
    medium_lines: number('risk', 'medium_lines', r.medium_lines, DEFAULTS.risk.medium_lines),
    high_lines: number('risk', 'high_lines', r.high_lines, DEFAULTS.risk.high_lines),
    medium_files: number('risk', 'medium_files', r.medium_files, DEFAULTS.risk.medium_files),
  };
}

// { level: 'low'|'medium'|'high', reasons[], changedLines, fileCount }
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

  if (hits.length > 0) {
    raise('high');
    reasons.push(`hard-stop: ${[...new Set(hits.map((h) => h.rule))].join(', ')}`);
  }

  const riskyPaths = [];
  for (const f of files) {
    const paths = [...new Set([f.oldPath, f.newPath, f.path].filter(Boolean))];
    if (paths.some((p) => matches(p, risk.high_risk_paths))) riskyPaths.push(f.path ?? f.newPath ?? f.oldPath);
  }
  if (riskyPaths.length > 0) {
    raise('high');
    const shown = riskyPaths.slice(0, 5).join(', ');
    reasons.push(`high-risk path: ${shown}${riskyPaths.length > 5 ? ` (+${riskyPaths.length - 5} more)` : ''}`);
  }

  if (changedLines > risk.high_lines) {
    raise('high');
    reasons.push(`${changedLines} changed lines > ${risk.high_lines}`);
  } else if (changedLines > risk.medium_lines) {
    raise('medium');
    reasons.push(`${changedLines} changed lines > ${risk.medium_lines}`);
  }

  if (fileCount > risk.medium_files) {
    raise('medium');
    reasons.push(`${fileCount} files > ${risk.medium_files}`);
  }

  if (reasons.length === 0) reasons.push('small change');
  return { level, reasons, changedLines, fileCount };
}

// The light lane skips the arbiter, so it is only for changes that are low risk, hit nothing, and are small.
export function isLightLane({ level, changedLines, hits, config }) {
  if (!LEVELS.includes(level)) throw new TypeError(`isLightLane: level must be one of ${LEVELS.join('|')}`);
  if (typeof changedLines !== 'number' || !Number.isFinite(changedLines)) throw new TypeError('isLightLane: changedLines must be a finite number');
  if (!Array.isArray(hits)) throw new TypeError('isLightLane: hits must be an array');
  const cap = number('review', 'light_lane_max_lines', config?.review?.light_lane_max_lines, DEFAULTS.review.light_lane_max_lines);
  return level === 'low' && hits.length === 0 && changedLines < cap;
}
