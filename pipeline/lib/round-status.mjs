// The review's status as the owner reads it: how many rounds ran, what they cost, which items are open and how serious, why the review is not clean. One gatherer
// feeds both the extra-round ask (`triage round-request`) and the park comment (`comment --kind needs-human`), so the two cannot drift. Display only: nothing here decides
// anything. Untrusted text (titles, categories) goes through asciiLine inside round-ask.mjs.
import { diffFiles, git, revParse } from './git.mjs';
import { trustedBase } from './risk.mjs';
import { diffStats } from './diff.mjs';
import { costFrom, notCleanReasons, openItems, roundsFrom, statusLines } from './round-ask.mjs';
import { currentContentHash, refreshBaseRef, reviewBaseRef } from './review-context.mjs';
import { readSummaryComment } from './summary-comment.mjs';
import { asciiLine, roundOutcome } from './triage.mjs';

// The config committed at the default branch's fork point (the trusted one rateBranch also reads: risk.mjs#trustedBase, anchored on the remote's default branch, not the
// working-tree config), for the union of the sensitive-path lists: a PR must not shrink its own list.
// -> { config, problem }: unreadable gives config null (its lists count as empty, nothing is loosened) and says why.
export function trustedBaseConfig(root, config) {
  try {
    const { trusted, mismatch } = trustedBase({ root, head: 'HEAD', config });
    if (!trusted.ok) return { config: null, problem: trusted.reason };
    // a readable committed config that names another default_branch still counts for the union (its lists are kept); the mismatch is the problem
    return { config: trusted.config, problem: mismatch };
  } catch (err) {
    return { config: null, problem: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
  }
}

// The files of the PR's reviewed diff (the last round's head against where the branch forked from the default branch): what a finding's location must resolve to.
// null (and a warning from the caller) when it cannot be read. Throws on nothing the caller needs to handle.
export function reviewedDiff(root, config, state) {
  const toHead = state.rounds.at(-1)?.toHead;
  if (typeof toHead !== 'string' || toHead === '') return { files: null, problem: 'the last round records no head' };
  try {
    return { files: diffFiles(reviewBaseRef(root, config), revParse(toHead, { cwd: root }), { cwd: root }), problem: null };
  } catch (err) {
    return { files: null, problem: asciiLine(err?.message, 160) };
  }
}

// The commits since the last reviewed head (what deferring would take out), and, when nothing explains them as fixes, how much changed.
export function sinceLastReview(root, config, state, { withChanges }) {
  const anchor = state.rounds.at(-1)?.toHead;
  const none = { anchor: null, count: 0, commits: [], changed: null };
  if (typeof anchor !== 'string' || anchor === '') return none;
  const o = { cwd: root };
  const full = revParse(anchor, o);
  const log = git(['log', '--format=%h %s', `${full}..HEAD`], o).split('\n').filter(Boolean);
  let changed = null;
  if (withChanges && log.length > 0) {
    const files = diffFiles(full, 'HEAD', o).filter((f) => f.path !== config.agent_log && f.newPath !== config.agent_log);
    changed = { commits: log.length, files: files.length, lines: diffStats(files).changedLines };
  }
  return { anchor: full.slice(0, 12), count: log.length, commits: log.slice(0, 20).map((l) => asciiLine(l, 100)), changed };
}

// Everything the ask and the park comment both show: { outcome, rounds, cost, diff, since, open, notClean, trusted } (trusted: trustedBaseConfig, read once here). A cost, diff, listing or severity problem becomes a warning (pushed to
// `warnings`) and a degraded value, never a throw; only the base-ref refresh and the content hash can throw, and the callers decide what that means.
export function gatherRoundStatus({ root, config, state, pr, gh, warnings }) {
  refreshBaseRef(root, config);
  const hash = currentContentHash(root, config);
  const outcome = roundOutcome({ ...state, currentContentHash: hash });
  const rounds = roundsFrom(state);
  let cost = null;
  try {
    const found = readSummaryComment(gh, pr);
    cost = found.status === 'ok' ? costFrom(found.record, rounds.reviewed, state) : null;
    if (cost === null) warnings.push(found.status === 'ok' ? 'the run record holds no booked cost yet' : `no usable run record on the PR (${found.status}): cost not shown`);
  } catch (err) {
    warnings.push(`the booked cost could not be read (${asciiLine(err?.message, 120)})`);
  }
  const diff = reviewedDiff(root, config, state);
  if (diff.problem) warnings.push(`the reviewed diff could not be read (${diff.problem}): every open item is shown as high`);
  let since = { anchor: null, count: 0, commits: [], changed: null };
  try {
    since = sinceLastReview(root, config, state, { withChanges: !outcome.coverageValid && outcome.newAccepted.length === 0 });
  } catch (err) {
    warnings.push(`the commits since the last review could not be listed (${asciiLine(err?.message, 120)})`);
  }
  const trusted = trustedBaseConfig(root, config);
  const open = openItems(state, outcome, { config, files: diff.files, baseConfig: trusted.config, baseProblem: trusted.problem }, warnings);
  const notClean = notCleanReasons(outcome, since.changed);
  return { outcome, rounds, cost, diff, since, open, notClean, trusted };
}

const SEVERITY_WARNING = /^(severity could not be judged|the reviewed diff could not be read)/;

// The status lines of the park comment (`comment --kind needs-human`): the ask's rounds / cost / open / not-clean lines without its recommendation (the park is the owner's
// decision). [] when the state is not this PR's or no round ran yet (nothing to report). NEVER throws: a failure drops the lines it touches and says so, so the park
// comment is always written. Every line is plain ASCII and one line.
export function parkStatusLines({ root, config, state, pr, gh }) {
  if (!state || state.pr !== pr || !Array.isArray(state.rounds) || state.rounds.length === 0) return [];
  const warnings = [];
  try {
    if (!config) throw new Error('pipeline.yml could not be read');
    const g = gatherRoundStatus({ root, config, state, pr, gh, warnings });
    const lines = statusLines({ rounds: g.rounds, cost: g.cost, open: g.open, notClean: g.notClean, asking: false });
    // Severity is what the Open line adds: when it could not be judged the line is dropped rather than shown as a guess.
    const openAt = lines.findIndex((l) => l.startsWith('Open:'));
    if (openAt >= 0 && warnings.some((w) => SEVERITY_WARNING.test(w))) lines[openAt] = 'Open: not available (severity could not be judged).';
    return lines.map((l) => asciiLine(l, 500));
  } catch (err) {
    let rounds = null;
    try {
      rounds = statusLines({ rounds: roundsFrom(state), cost: null, open: [], notClean: [], asking: false })[0];
    } catch { /* the rounds line is the one that needs only the state */ }
    return [...(rounds ? [asciiLine(rounds, 500)] : []), asciiLine(`Cost and open items: not available (${asciiLine(err?.message, 120)}).`, 500)];
  }
}
