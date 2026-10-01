// Risk level of a PR: how much human attention it deserves, and whether it qualifies for the light review lane.
// Why a pure function over (files, hits, config): the level decides the review effort and the E2E label, so it must be
// reproducible from the same inputs locally and in CI. Anything a hard-stop flagged is `high` by definition; size and
// risky paths only add to that. Path matching tests the old AND new path (a rename out of a risky dir is still a change
// to it) and also the lower-cased path, so a case-only difference can never hide a risky path on a case-folding filesystem.
import { diffStats } from './diff.mjs';
import { matchAny } from './glob.mjs';
import { DEFAULTS } from './config.mjs';

const matches = (p, globs) => matchAny(p, globs) || matchAny(p.toLowerCase(), globs);

function thresholds(config) {
  return { ...DEFAULTS.risk, ...(config?.risk ?? {}) };
}

// { level: 'low'|'medium'|'high', reasons[], changedLines, fileCount }
export function assessRisk({ files, hits, config }) {
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
  const cap = config?.review?.light_lane_max_lines ?? DEFAULTS.review.light_lane_max_lines;
  return level === 'low' && hits.length === 0 && changedLines < cap;
}
