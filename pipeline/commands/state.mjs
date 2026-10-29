// Reads and updates .review/state.json for the skills: which items are open, whether the loop may exit, and the few
// facts only the skill knows (an item was implemented, a follow-up issue exists, how the run ended). The state is the
// only memory of the review loop, so a lost local copy is rebuilt from the PR's triage comment, which embeds it.
import { EXIT, UnavailableError, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { effectiveReviewBase, git, isAncestor, mergeBase, revParse } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { matchAny } from '../lib/glob.mjs';
import { MARKERS } from '../lib/render.mjs';
import { decodeFromComment, loadState, saveState, updateItems } from '../lib/state.mjs';
import { reviewedRoundCount, roundOutcome } from '../lib/triage.mjs';
import {
  allItems, currentContentHash, findItem, findRound, followupsPending, newStaleDir, quarantineReviewDir, requireState, reviewBaseRef,
  roundDir, stateExtends, withStateLock,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'show or update the review loop state (.review/state.json)',
  usage: [
    'pipeline state show [--round R] [--accepted] [--disputed] [--needs-human] [--pr N] [--repo DIR]',
    '  -> {ok, recovered, source, count, items}; with --pr and no local state, rebuilds it from the PR triage comment',
    '  with --pr and a local state: the published (triage comment) state is authoritative. Local is kept (source local) when it',
    '  equals or strictly EXTENDS the published one; otherwise .review/ moves to .review/stale-<UTC time>/ (source quarantined,',
    '  quarantinedTo) and the published state is restored. source is local | published | quarantined | local-unverified',
    '  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)',
    'pipeline state discard-round --round R [--pr N] [--repo DIR]',
    '  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;',
    '     refused (exit 2) when the PR triage comment already holds round R',
    'pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, followupsPending}; exit 0 whether or not clean',
    'pipeline state mark-implemented --ids a,b [--repo DIR]',
    '  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed',
    '     and a non-test file changed since (a test file counts for a testing finding or the finding\'s own file)',
    'pipeline state record-followup --id ID --url URL [--repo DIR]',
    'pipeline state set-outcome --outcome TEXT [--repo DIR]',
  ].join('\n'),
};

// ---- show -----------------------------------------------------------------------------------

const isAccepted = (i) => i.final?.decision === 'ACCEPT' && !i.implemented;
const isDisputed = (i) => i.judge?.disputedBug === true && i.judge.settleTest?.possible === true && (i.test?.status ?? 'none') === 'none';
const needsHuman = (i) => i.final?.needsHuman === true;

// Newest comment of ours that STARTS with the triage marker: a quoted or forged marker in someone else's comment
// (or in the middle of ours) must never become the state.
function recoverState(root, pr, ctx) {
  return guardGh(() => {
    const gh = createGitHub({ cwd: root, env: ctx.env });
    const me = gh.viewer();
    const mine = gh.listComments(pr)
      .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.triage) && c.user?.login === me)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const state = mine.length > 0 ? decodeFromComment(mine.at(-1).body) : null;
    return state && state.pr === pr ? state : null;
  });
}

async function show(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, accepted: { type: 'boolean' }, disputed: { type: 'boolean' },
    'needs-human': { type: 'boolean' }, pr: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { min: 1 });
  const pr = intOption(values, 'pr', { min: 1 });
  const root = resolveRepo(values, ctx);
  // `show` may rebuild the state file, so it takes the lock like the commands that change it.
  return withStateLock(root, ctx, () => showLocked(values, n, pr, root, ctx), pr);
}

async function showLocked(values, n, pr, root, ctx) {
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
  let recovered = false;
  let source = 'local';
  const warnings = [];
  let quarantinedTo;
  if (!state) {
    if (pr === undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-state', message: 'no review state here: pass --pr N to rebuild it from the PR triage comment' });
    }
    state = await recoverState(root, pr, ctx);
    if (!state) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-state', message: `no local review state and no triage comment with state on PR #${pr}` });
    }
    saveState(root, state);
    recovered = true;
    source = 'published';
  } else if (pr !== undefined && state.pr !== pr) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${state.pr}, not #${pr}` });
  } else if (pr !== undefined) {
    // The triage comment is what survives the machine: when the two disagree the published one wins, unless the local
    // state only goes further (its extra rounds were never published).
    // GitHub unreachable: the local state is all there is. It is served, but flagged: it was NOT compared with the published
    // triage comment, so the caller must not treat it as proven current.
    let published;
    try {
      published = await recoverState(root, pr, ctx);
    } catch (err) {
      if (!(err instanceof UnavailableError)) throw err;
      warnings.push(`GitHub unavailable: the local review state was not compared with the published triage comment (${String(err.message).split('\n')[0].slice(0, 200)})`);
      source = 'local-unverified';
    }
    if (published && !stateExtends(state, published)) {
      quarantinedTo = path.relative(root, quarantineReviewDir(root)).split(path.sep).join('/');
      state = published;
      saveState(root, state);
      source = 'quarantined';
    }
  }

  const pool = n === undefined ? allItems(state) : findRound(state, n).items;
  const items = pool.filter((i) => (!values.accepted || isAccepted(i)) && (!values.disputed || isDisputed(i)) && (!values['needs-human'] || needsHuman(i)));
  return {
    exitCode: EXIT.OK,
    output: { ok: true, recovered, source, ...(quarantinedTo ? { quarantinedTo } : {}), ...(warnings.length ? { warnings } : {}), pr: state.pr, lightLane: state.lightLane, count: items.length, items },
  };
}

// ---- discard-round --------------------------------------------------------------------------

// An interrupted round (Codex ran, the loop stopped before the triage comment) is thrown away and re-run under the same
// number. What is moved aside is kept, never deleted; a round the PR comment already holds is history and stays.
async function discardRound(rest, ctx) {
  const { values } = parseCommandArgs(rest, { round: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  let pr = intOption(values, 'pr', { min: 1 });
  const root = resolveRepo(values, ctx);
  const local = requireState(root);
  pr ??= local.pr;
  if (local.pr !== pr) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${local.pr}, not #${pr}` });
  }
  return withStateLock(root, ctx, async () => {
    const state = requireState(root);
    const inState = (state.rounds ?? []).some((r) => r.n === n);
    const dir = roundDir(root, n);
    if (!inState && !existsSync(dir)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'no-round', message: `round ${n} is neither in the review state nor on disk` });
    }
    if (inState && (state.rounds ?? []).some((r) => r.n > n)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'not-trailing', message: `round ${n} is not the newest round: a later round builds on it` });
    }
    const published = await recoverState(root, pr, ctx);
    if ((published?.rounds ?? []).some((r) => r.n === n)) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'round-published', message: `round ${n} is in the PR triage comment: it is history, not an interrupted round` });
    }
    const stale = newStaleDir(root);
    const round = (state.rounds ?? []).find((r) => r.n === n);
    if (round) writeFileSync(path.join(stale, `state-round-${n}.json`), `${JSON.stringify(round, null, 2)}\n`);
    if (existsSync(dir)) {
      mkdirSync(stale, { recursive: true });
      renameSync(dir, path.join(stale, `round-${n}`));
    }
    if (inState) saveState(root, { ...state, rounds: state.rounds.filter((r) => r.n !== n) });
    return {
      exitCode: EXIT.OK,
      output: { ok: true, discarded: n, quarantinedTo: path.relative(root, stale).split(path.sep).join('/'), stateRound: inState },
    };
  }, pr);
}

// ---- outcome --------------------------------------------------------------------------------

async function outcome(rest, ctx) {
  const { values } = parseCommandArgs(rest, { repo: { type: 'string' } }, { allowPositionals: false });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const state = requireState(root);
  const hash = currentContentHash(root, config);
  const result = roundOutcome({ ...state, currentContentHash: hash });
  return {
    exitCode: EXIT.OK,
    output: { ok: true, ...result, followupsPending: followupsPending(state), currentContentHash: hash, rounds: state.rounds.length, reviewedRounds: reviewedRoundCount(state), maxRounds: state.maxRounds },
  };
}

// What to diff HEAD against when the default branch was merged into the PR with a conflict since `toHead`: walk the merge commits of
// the default branch on HEAD's first-parent history after `toHead`, OLDEST first (the first is the one that resolved the conflict), and
// take the first whose own review base is exact (effectiveReviewBase from that merge: 'previous', or 'synthetic' when the default branch
// was merged in again cleanly later, which leaves main's later files out). A merge counts only when its second parent is part of the
// default branch (a merge of any other branch says nothing about what main brought in). A merge whose own base is still 'whole-pr'
// (a second conflict) is skipped in favour of the next one. null when none gives an exact base: the caller refuses. Throws on a git error.
function baseAfterConflictMerge({ root, config, toHead, forkPoint }) {
  const o = { cwd: root };
  const baseRef = reviewBaseRef(root, config);
  const merges = git(['rev-list', '--first-parent', '--merges', '--reverse', `${revParse(toHead, o)}..HEAD`], o).split('\n').filter(Boolean);
  for (const m of merges) {
    const parents = git(['rev-list', '--parents', '-n', '1', m], o).trim().split(/\s+/).slice(1);
    if (parents.length !== 2 || !isAncestor(parents[1], baseRef, o)) continue;
    const since = effectiveReviewBase({ from: m, forkPoint }, o);
    if (since.kind === 'previous' || since.kind === 'synthetic') return since.base;
  }
  return null;
}

// ---- small updates --------------------------------------------------------------------------

async function markImplemented(rest, ctx) {
  const { values } = parseCommandArgs(rest, { ids: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const ids = [...new Set(requireOption(values, 'ids').split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new UsageError('--ids must list at least one item id');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  return withStateLock(root, ctx, () => {
    let state = requireState(root);
    // Resolve every id first so a typo cannot leave the state half-updated.
    const found = ids.map((id) => findItem(state, id));
    for (const { item } of found) {
      if (item.final?.decision !== 'ACCEPT') {
        throw new Fail(EXIT.USAGE, { ok: false, error: 'not-accepted', message: `${item.id} is not an accepted item, so it cannot be marked implemented` });
      }
    }
    // An accepted item is only "implemented" by a change to the code: the branch content must differ from what the
    // round that accepted it reviewed. Otherwise an empty fix and an empty review round would clear a BLOCKING finding.
    const hash = currentContentHash(root, config);
    for (const { round, item } of found) {
      if (hash === round.contentHashAtToHead) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'no-code-change',
          message: `${item.id} cannot be marked implemented: the branch content is identical to what round ${round.n} reviewed (no fix has been committed)`,
        });
      }
      // A settle-by-test commit changes the hash too, so also require a non-test file to have changed since then.
      // Measured from the round's head, minus whatever was merged in from the default branch since (those are not the PR's
      // change). This gate fails closed: if that range cannot be worked out exactly (git failed, or a conflicting merge
      // whose resolution is not recorded as a merge commit), the mark is refused rather than counting files the fix did not touch.
      let changed;
      try {
        const forkPoint = mergeBase(reviewBaseRef(root, config), 'HEAD', { cwd: root });
        const since = effectiveReviewBase({ from: round.toHead, forkPoint }, { cwd: root });
        let base = since.base;
        if (since.kind === 'whole-pr') {
          // The trial merge conflicted (or is unsupported), and it will never change: both of its inputs are fixed. The PR's
          // own work since then is measured from the merge commit that resolved the conflict.
          base = baseAfterConflictMerge({ root, config, toHead: round.toHead, forkPoint });
          if (base === null) {
            throw new Error(`the default branch was merged into the PR since round ${round.n} with a conflict, and no merge commit of the default branch after that round records the resolution, so the PR's own changes cannot be told apart from the default branch's`);
          }
        } else if (since.kind !== 'previous' && since.kind !== 'synthetic') {
          throw new Error(`unexpected review base kind ${since.kind}`);
        }
        changed = git(['diff', '--name-only', '--no-renames', `${base}..HEAD`], { cwd: root }).split('\n').filter(Boolean);
      } catch (err) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'base-unresolved',
          message: `${item.id} cannot be marked implemented: could not tell which files changed since round ${round.n} (${err.message})`,
        });
      }
      const own = changed.filter((f) => f !== config.agent_log);
      const code = own.filter((f) => !matchAny(f, config.integrity.test_globs));
      // A test file is the fix itself when the finding is about the tests (category testing) or names that very file
      // (a helper under a test glob, #53). A settle-by-test commit touches neither, so it still does not count.
      const itemFile = String(item.file ?? '').replace(/^\.\//, '');
      const testFix = own.length > 0 && (item.category === 'testing' || (itemFile !== '' && own.includes(itemFile)));
      if (code.length === 0 && !testFix) {
        throw new Fail(EXIT.USAGE, {
          ok: false, error: 'no-code-change',
          message: `${item.id} cannot be marked implemented: since round ${round.n} only test files changed (${changed.join(', ') || 'nothing'}); commit the fix itself (a test-only fix counts only for a testing finding or one about that test file)`,
        });
      }
    }
    for (const { round, item } of found) state = updateItems(state, round.n, [{ ...item, implemented: true }]);
    saveState(root, state);
    return { exitCode: EXIT.OK, output: { ok: true, marked: ids } };
  });
}

function recordFollowup(rest, ctx) {
  const { values } = parseCommandArgs(rest, { id: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const id = requireOption(values, 'id');
  const url = requireOption(values, 'url');
  if (!/^https?:\/\/\S+$/.test(url)) throw new UsageError('--url must be an http(s) URL');
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    const { round, item } = findItem(state, id);
    saveState(root, updateItems(state, round.n, [{ ...item, followupIssue: url }]));
    return { exitCode: EXIT.OK, output: { ok: true, id, url } };
  });
}

function setOutcome(rest, ctx) {
  const { values } = parseCommandArgs(rest, { outcome: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const text = requireOption(values, 'outcome').replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > 200) throw new UsageError('--outcome must be 1-200 characters of plain text');
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    saveState(root, { ...state, outcome: text });
    return { exitCode: EXIT.OK, output: { ok: true, outcome: text } };
  });
}

const SUBCOMMANDS = {
  show, 'discard-round': discardRound, outcome, 'mark-implemented': markImplemented, 'record-followup': recordFollowup, 'set-outcome': setOutcome,
};

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline state ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
