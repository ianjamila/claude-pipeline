// Reads and updates .review/state.json for the skills: which items are open, whether the loop may exit, and the few
// facts only the skill knows (an item was implemented, a follow-up issue exists, how the run ended). The state is the
// only memory of the review loop, so a lost local copy is rebuilt from the PR's triage comment, which embeds it.
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { MARKERS } from '../lib/render.mjs';
import { decodeFromComment, loadState, saveState, updateItems } from '../lib/state.mjs';
import { roundOutcome } from '../lib/triage.mjs';
import {
  allItems, currentContentHash, findItem, findRound, requireState, withStateLock,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'show or update the review loop state (.review/state.json)',
  usage: [
    'pipeline state show [--round R] [--accepted] [--disputed] [--needs-human] [--pr N] [--repo DIR]',
    '  -> {ok, recovered, count, items}; with --pr and no local state, rebuilds it from the PR triage comment',
    'pipeline state outcome [--repo DIR]   -> roundOutcome + {clean}; exit 0 whether or not clean',
    'pipeline state mark-implemented --ids a,b [--repo DIR]',
    '  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed',
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
  } else if (pr !== undefined && state.pr !== pr) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state-pr-mismatch', message: `.review/state.json belongs to PR #${state.pr}, not #${pr}` });
  }

  const pool = n === undefined ? allItems(state) : findRound(state, n).items;
  const items = pool.filter((i) => (!values.accepted || isAccepted(i)) && (!values.disputed || isDisputed(i)) && (!values['needs-human'] || needsHuman(i)));
  return { exitCode: EXIT.OK, output: { ok: true, recovered, pr: state.pr, lightLane: state.lightLane, count: items.length, items } };
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
    output: { ok: true, ...result, currentContentHash: hash, rounds: state.rounds.length, maxRounds: state.maxRounds },
  };
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
  show, outcome, 'mark-implemented': markImplemented, 'record-followup': recordFollowup, 'set-outcome': setOutcome,
};

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline state ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
