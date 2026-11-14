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
import { DEFAULTS, RISK_IGNORABLE_RULES, baseConfigAt } from './config.mjs';
import { collectHardStops } from './hardstops.mjs';
import { diffFiles, hasOriginRemote, lsRemoteDefaultBranch, mergeBase, remoteDefaultBranch, reviewBaseRef } from './git.mjs';

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

// The default branch every review-path decision measures "is this the default branch" against (#398, #377): what the remote calls its default, from a source a PR cannot edit
// (anchor 'origin-head': refs/remotes/origin/HEAD; 'ls-remote': `git ls-remote --symref origin HEAD`, asked once per process, read-only, best effort, only when origin/HEAD is
// absent). Only a clone with no origin remote at all (a local-only repo, a fixture) takes the working-tree config's default_branch, anchor 'config', trusted as before. A clone WITH
// an origin remote that neither source answers for (offline, no origin/HEAD) also falls back to the config value, but that value is the PR's to edit (a working tree naming branch X
// whose commit also names X would pass the mismatch check): it is returned as `untrusted` (a sentence naming the remedy), which trustedBase turns into the same refusal as a
// mismatch (Fable, substitute off, a lane reason). admitRound's base rule (what counts as merged in from the default branch, the base a missing baseRefName falls back to),
// review-complete's lane and rateBranch's stacked test all read it through here, so a PR that names its own base branch as default_branch cannot make that branch's commits
// read as the default branch's. `remote`: the remote's default branch when it anchored, else null.
// -> { branch, remote, anchor: 'origin-head'|'ls-remote'|'config', untrusted: string | null }
export function trustedDefaultBranch(root, config) {
  const o = { cwd: root };
  const configured = config?.default_branch ?? DEFAULTS.default_branch; // a partial or null config is tolerated (Fable F7)
  const fromHead = remoteDefaultBranch(o);
  if (fromHead !== null) return { branch: fromHead, remote: fromHead, anchor: 'origin-head', untrusted: null };
  if (!hasOriginRemote(o)) return { branch: configured, remote: null, anchor: 'config', untrusted: null };
  const asked = lsRemoteDefaultBranch(o);
  if (asked !== null) return { branch: asked, remote: asked, anchor: 'ls-remote', untrusted: null };
  return {
    branch: configured, remote: null, anchor: 'config',
    untrusted: `the default branch could not be anchored on the remote (no refs/remotes/origin/HEAD, and \`git ls-remote --symref origin HEAD\` named none), so the working-tree config's default_branch ${JSON.stringify(configured)} is the only source and a PR can edit it (fix: \`git remote set-head origin -a\`)`,
  };
}

// The ONE branch every content-hash and behind-base site measures from (#448): trustedDefaultBranch's answer, never the working-tree config's default_branch a PR can edit (that value is
// only the fallback of a clone with no origin remote). `config` may be partial or null. -> string
export function hashBranch(root, config) {
  return trustedDefaultBranch(root, config).branch;
}

// The branch a PR is read as targeting, for the commands that fetch / measure a range from it: GitHub's answer (the PR's baseRefName) wins; without one, the TRUSTED default branch
// (trustedDefaultBranch), never a config value a PR can edit. `untrusted` is set only when that fallback was needed AND its anchor is the working tree's (an origin remote that did
// not answer): that branch is the PR's to choose and must not be what narrows a reviewed range, so the callers refuse (or keep what they recorded) instead of using it (S1).
// -> { branch, untrusted: string | null }
export function prBaseBranch(view, root, config) {
  if (typeof view?.baseRefName === 'string' && view.baseRefName !== '') return { branch: view.baseRefName, untrusted: null };
  const { branch, untrusted } = trustedDefaultBranch(root, config);
  return { branch, untrusted };
}

// The trust anchor of the rating, shared with the status display (round-status.mjs#trustedBaseConfig): the default branch is what the remote calls its default
// (refs/remotes/origin/HEAD; only a clone without that ref falls back to the working-tree config's default_branch, which a PR can edit), the trusted fork point is
// mergeBase(origin/<that>, head), and the trusted config is the one committed there. A committed config that names a different default_branch than the
// working-tree config is not fully trusted (the PR moved the anchor): its rules are still evaluated (a PR must not lose them by editing default_branch), but
// the mismatch is returned apart as `mismatch` and the callers require Fable. `remoteDefault` is the remote's default branch when it was used and differs from
// the working-tree config's default_branch (a repo where they disagree on purpose, or origin/HEAD is stale), else null.
// `trustedFork` (optional): the fork point when the caller already has it (adm.rated.trustedFork, from rateBranch); the merge base is then not worked out again.
// `mismatch` also carries an anchor that came from the working tree although an origin remote exists (trustedDefaultBranch's `untrusted`): the callers read it as "no trusted base config".
// `untrusted` is trustedDefaultBranch's (a sentence, or null): it tells a mismatch whose ANCHOR is genuine (the remote named the default branch; only the working tree's default_branch moved, so
// the fork point and the config committed there are the real ones) from one whose anchor the PR could have chosen (no trusted fork point at all).
// -> { defaultBranch, anchor, untrusted, trustedFork, trusted: { ok: true, config } | { ok: false, reason }, mismatch: string | null, remoteDefault: string | null }. Throws what git throws (no fork point).
export function trustedBase({ root, head, config, trustedFork: given }) {
  const o = { cwd: root };
  const { branch: defaultBranch, remote, anchor, untrusted } = trustedDefaultBranch(root, config);
  const trustedFork = given ?? mergeBase(reviewBaseRef(defaultBranch, o), head, o);
  const trusted = baseConfigAt(trustedFork, root);
  const mismatch = untrusted ?? (trusted.ok && trusted.config.default_branch !== config.default_branch
    ? `the config at the fork point names default_branch ${JSON.stringify(trusted.config.default_branch)}, the working-tree config ${JSON.stringify(config.default_branch)}`
    : null);
  return { defaultBranch, anchor, untrusted, trustedFork, trusted, mismatch, remoteDefault: remote !== null && remote !== config.default_branch ? remote : null };
}

// ---- the whole decision, under the working-tree config AND the trusted base config ------------------------------------------------
//
// One shared function for codex-review, review-complete and `pipeline risk`: the hard-stop scan, the level and the lane are worked out twice, once with
// the working-tree config and once with the config COMMITTED at mergeBase(origin/<default branch>, head) (never the PR's own base branch), and the
// stricter result wins on every axis. A PR (committed, staged or unstaged edits of .claude/pipeline.yml) therefore cannot loosen the thresholds, the
// sensitive paths, the hard-stop paths, the ignore list or the size-only reviewer that rate it. The same config twice is evaluated once. A base config
// that is missing, unreadable or invalid means the rating cannot be trusted: the reviewer is Fable, whatever the level.
// The default branch that anchors the trusted fork point is never taken from the working-tree config (a PR can edit it): it is what the remote calls its
// default (refs/remotes/origin/HEAD); only a clone without that ref falls back to the config's default_branch. Whichever is used, a config committed at
// that fork point that names a different default_branch than the working-tree config is no trusted base config either (Fable).
// A PR whose base branch is not the default branch (a stack) never gets the size-only judge, and is rated over BOTH ranges, its own (`base`, what
// codex-review reviews) and the default branch's fork point (what review-complete rates, parent branch included), stricter wins: codex-review therefore
// records the Fable round review-complete will ask for.
// `base` (optional) is the ref the diff starts from; it defaults to the trusted fork point (codex-review passes its own, stack-aware, fork point).
// Throws what the scan throws (the callers decide how to fail closed). -> {
//   level, reasons, changedLines, fileCount, drivers, sizeOnly, reviewer, laneReasons, sensitivePaths, sizeOnlyJudge, note, hits, files, lightLane,
//   trustedFork, baseConfig: { ok, reason? }, stacked, defaultBranch, anchor, untrusted }
// `defaultBranch` is the trusted one and `anchor` where it came from ('origin-head' | 'ls-remote' | 'config', trustedDefaultBranch), for a caller that decides "is the PR's base the default branch" (admitRound's base rule, #398); `untrusted` (a sentence, or null) says the anchor came from the working tree although an origin remote exists:
// such a default branch is the PR's to choose and must not narrow a reviewed range (S1).
export async function rateBranch({ root, head, config, prBase, base }) {
  const o = { cwd: root };
  const { defaultBranch, anchor, untrusted, trustedFork, trusted, mismatch, remoteDefault } = trustedBase({ root, head, config });
  const trustedOk = trusted.ok && mismatch === null;
  prBase ??= defaultBranch;
  const from = base ?? trustedFork;
  const stacked = prBase !== defaultBranch;
  const sameConfig = trusted.ok && JSON.stringify(trusted.config) === JSON.stringify(config);
  const configs = [['', config], ...(trusted.ok && !sameConfig ? [['base config: ', trusted.config]] : [])];
  const files = diffFiles(from, head, o);
  const ranges = [['', from, files], ...(stacked && from !== trustedFork ? [['default branch range: ', trustedFork, diffFiles(trustedFork, head, o)]] : [])];

  const rated = [];
  for (const [rangeLabel, rangeBase, rangeFiles] of ranges) {
    for (const [label, cfg] of configs) {
      const hits = await collectHardStops({ base: rangeBase, head, cwd: root, config: cfg });
      const risk = assessRisk({ files: rangeFiles, hits, config: cfg });
      const lane = reviewLane({ level: risk.level, files: rangeFiles, config: cfg, sizeOnly: risk.sizeOnly && !stacked });
      const lightLane = isLightLane({ level: risk.level, changedLines: risk.changedLines, hits, config: cfg });
      rated.push({ label: rangeLabel + label, hits, risk, lane, lightLane });
    }
  }

  const level = LEVELS[Math.max(...rated.map((r) => LEVELS.indexOf(r.risk.level)))];
  const ordered = (pick) => {
    const seen = new Set();
    const out = [];
    for (const r of rated) {
      for (const x of pick(r)) {
        if (seen.has(x)) continue;
        seen.add(x);
        out.push(r.label + x);
      }
    }
    return out;
  };
  const reasons = ordered((r) => r.risk.reasons);
  const laneReasons = ordered((r) => r.lane.reasons);
  const sizeCandidate = rated.some((r) => r.risk.sizeOnly);
  if (stacked && sizeCandidate) reasons.push(`stacked PR: base is ${prBase} (no size-only judge)`);
  if (!trusted.ok) laneReasons.push(`trusted base config unreadable: ${trusted.reason}`);
  else if (mismatch !== null) laneReasons.push(`trusted base config unreadable: ${mismatch}`);
  if (remoteDefault !== null) {
    const source = anchor === 'ls-remote' ? 'the remote (git ls-remote --symref origin HEAD; origin/HEAD is not set)' : 'origin/HEAD';
    laneReasons.push(`${source} names default branch ${JSON.stringify(remoteDefault)}, pipeline.yml names ${JSON.stringify(config.default_branch)}: the rating follows ${anchor === 'ls-remote' ? 'the remote' : 'origin/HEAD'}. The pipeline supports only GitHub's default branch as its main: set default_branch: ${remoteDefault} in pipeline.yml, or make ${JSON.stringify(config.default_branch)} the default branch on GitHub (fix a stale origin/HEAD with \`git remote set-head origin -a\`)`);
  }
  // The collector's own identity (hardstops.mjs makeSink: rule, file, line; the detail when there is no line), and the stricter status
  // (blocking > ownerMerge > report-only) when both configs report the same hit.
  const strength = (h) => (h?.advisory !== true ? 2 : h.ownerMerge === true ? 1 : 0);
  const merged = new Map();
  for (const h of rated.flatMap((r) => r.hits)) {
    const key = `${h?.rule}\0${h?.file}\0${h?.line ?? ''}\0${h?.line === undefined ? h?.detail : ''}`;
    const seen = merged.get(key);
    if (seen === undefined || strength(h) > strength(seen)) merged.set(key, h);
  }
  const hits = [...merged.values()];
  const sensitivePaths = [...new Set(rated.flatMap((r) => r.lane.sensitivePaths))];
  // Size alone raised the level in at least one evaluation and every other evaluation is plainly low (no raw hit, no sensitive path): the judge
  // lane review-complete accepts. A low evaluation next to a size-only medium one (the configs disagree on a threshold) must not deadlock it.
  const sizeOnly = trustedOk && !stacked && rated.some((r) => r.risk.sizeOnly)
    && rated.every((r) => r.risk.sizeOnly || (r.risk.level === 'low' && r.hits.length === 0));
  // A medium that is not size-only overall (one evaluation's size-only judge lane next to another's low-with-a-hit) is Fable: review-complete
  // accepts a recorded medium on judge rounds only when sizeOnly is true, so the lane and that check must agree.
  const mediumNotSizeOnly = level === 'medium' && !sizeOnly;
  if (mediumNotSizeOnly && !laneReasons.some((x) => x.endsWith('medium risk'))) laneReasons.push('medium risk');
  const reviewer = !trustedOk || mediumNotSizeOnly || rated.some((r) => r.lane.reviewer === 'fable') ? 'fable' : 'judge';
  const sizeOnlyJudge = reviewer === 'judge' && rated.some((r) => r.lane.sizeOnlyJudge === true);
  const first = rated[0].risk;
  return {
    level, reasons, changedLines: first.changedLines, fileCount: first.fileCount,
    drivers: {
      hardStop: rated.some((r) => r.risk.drivers.hardStop), advisory: rated.some((r) => r.risk.drivers.advisory),
      path: rated.some((r) => r.risk.drivers.path), size: rated.some((r) => r.risk.drivers.size),
    },
    sizeOnly, reviewer, laneReasons, sensitivePaths, ...(sizeOnlyJudge ? { sizeOnlyJudge: true, note: SIZE_ONLY_NOTE } : {}),
    hits, files, lightLane: rated.every((r) => r.lightLane), trustedFork, baseConfig: trustedOk ? { ok: true, same: sameConfig } : { ok: false, reason: trusted.ok ? mismatch : trusted.reason }, stacked, defaultBranch, anchor, untrusted,
  };
}
