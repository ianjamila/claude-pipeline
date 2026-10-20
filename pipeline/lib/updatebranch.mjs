// Bring a PR branch up to date with its base BEFORE the final gate, so the gate (and the CI it waits on) judge the tree that
// will actually land. GitHub does the merge (`PUT pulls/{n}/update-branch` with `expected_head_sha`): no local push, no force
// push, and a head that moved since we looked is refused by GitHub itself. This module only decides WHEN to call it and what
// every answer means. Every outcome other than `up-to-date` stops the caller; none of them is retried blindly:
//   rebase-needed   the update conflicts: a human (or the implementer) must rebase/merge by hand
//   head-moved      someone pushed since we read the head: stop and re-read before touching anything
//   cycle-cap       main kept moving: after `maxCycles` updates the branch is still behind
//   checks-failed / checks-timeout / head-timeout   the update was accepted but the new head did not turn green in time
//   not-open        the PR is closed or merged
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MAX_UPDATE_CYCLES = 3;
export const HEAD_WAIT_MS = 120_000;
export const CHECKS_WAIT_MS = 30 * 60_000;
export const POLL_MS = 15_000;
const VIEW_FIELDS = ['state', 'headRefOid', 'baseRefName'];

// Test hook: PIPELINE_UPDATE_WAIT_MS / PIPELINE_UPDATE_POLL_MS can only SHORTEN the waits (a shorter wait ends in a
// "timeout" outcome, the safe direction), never stretch them.
export function updateTiming(env = {}) {
  const wait = Number(env?.PIPELINE_UPDATE_WAIT_MS);
  const poll = Number(env?.PIPELINE_UPDATE_POLL_MS);
  const cap = (limit) => (Number.isInteger(wait) && wait >= 0 ? Math.min(wait, limit) : limit);
  return {
    headWaitMs: cap(HEAD_WAIT_MS),
    checksWaitMs: cap(CHECKS_WAIT_MS),
    pollMs: Number.isInteger(poll) && poll >= 0 && poll < POLL_MS ? poll : POLL_MS,
  };
}

// gh's own "nothing there yet" answers, which are data. Anything else (auth, 5xx, a timeout) is GitHub being unavailable.
const NO_CHECKS = /no (?:required )?checks reported/i;

// The required checks of the PR's current head, falling back to every reported check when GitHub requires none. Only the
// recognised "no checks reported" answer falls through; any other failure propagates (the command maps it to exit 3).
function readChecks(gh, pr) {
  for (const required of [true, false]) {
    try {
      const rows = gh.checks(pr, { required });
      if (Array.isArray(rows) && rows.length > 0) return rows;
    } catch (err) {
      if (err?.timedOut === true || !NO_CHECKS.test(`${err?.stderr ?? ''}\n${err?.stdout ?? ''}`)) throw err;
    }
  }
  return [];
}

// 'pass' | 'fail' | 'timeout'. Checks appear a few seconds after a push, so an empty list keeps waiting; "all done" must
// hold on two polls in a row (a workflow that registers a moment late must not be missed).
async function waitForChecks({ gh, pr, waitMs, pollMs, now, sleep }) {
  const deadline = now() + waitMs;
  let settled = false;
  for (;;) {
    const rows = readChecks(gh, pr);
    if (rows.some((r) => r?.bucket === 'fail' || r?.bucket === 'cancel')) return 'fail';
    const done = rows.length > 0 && rows.every((r) => r?.bucket && r.bucket !== 'pending');
    if (done && settled) return 'pass';
    settled = done;
    const left = deadline - now();
    if (left <= 0) return 'timeout';
    await sleep(Math.min(pollMs, left));
  }
}

// The new head, or null when the PR head did not change within the wait. GitHub answers update-branch with 202 and
// creates the merge commit asynchronously.
async function waitForNewHead({ gh, pr, from, waitMs, pollMs, now, sleep }) {
  const deadline = now() + waitMs;
  for (;;) {
    const head = gh.prView(pr, VIEW_FIELDS).headRefOid;
    if (head !== from) return head;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(pollMs, left));
  }
}

// Runs update cycles until the base tip is part of the PR head. `expectHead` pins the head the caller has verified (the
// worktree's HEAD): a PR head that differs is `head-moved` before anything is written. The new head is accepted only if it is
// the merge commit GitHub makes, parents exactly [the pinned head, the base tip captured with the behind count]; any other
// successor (an external push that raced the update) is `head-moved` and nothing more is written. Waiting for the new head's
// checks is opt-in (`waitChecks: true`): the ship flow marks the PR ready and labels it AFTER updating, and checks that only
// start then (draft-skipped workflows, label-gated e2e) would otherwise be waited on forever. Merge needs no check wait either.
// Every return carries `updates`: the {headBefore, baseTip} pair (both 40-hex SHAs; `base` stays the branch name) of each update
// whose result was confirmed as the merge of the base tip into the head, so a cycle-cap / checks-failed / head-timeout exit after a
// confirmed update still reports it. A THROW after one carries the same array on the error (`err.updates`), so the caller can record
// it before rethrowing (the busy-main hand-off counts these, cp #88).
export async function bringUpToDate(opts) {
  const updates = [];
  try {
    return await updateLoop(opts, updates);
  } catch (err) {
    if (err !== null && typeof err === 'object') err.updates = updates;
    throw err;
  }
}

async function updateLoop({
  gh, pr, expectHead = null, maxCycles = MAX_UPDATE_CYCLES, waitChecks = false,
  headWaitMs = HEAD_WAIT_MS, checksWaitMs = CHECKS_WAIT_MS, pollMs = POLL_MS, now = Date.now, sleep = defaultSleep,
}, updates) {
  let cycles = 0;
  let startHead = null;
  let known = expectHead;
  let base = null;
  const out = (outcome, extra = {}) => ({
    ok: outcome === 'up-to-date', outcome, updated: cycles > 0, cycles, base, startHead, updates: updates.map((u) => ({ ...u })), ...extra,
  });

  for (;;) {
    const view = gh.prView(pr, VIEW_FIELDS);
    base = view.baseRefName ?? base;
    const head = view.headRefOid;
    startHead ??= head;
    if (view.state !== 'OPEN') return out('not-open', { head, message: `PR state is ${view.state}` });
    if (known !== null && head !== known) {
      return out('head-moved', { head, message: `the PR head is ${head}, not the ${known} that was verified: re-read and decide; nothing was updated` });
    }
    const cmp = gh.compare(base, head);
    if (cmp.behindBy === 0) return out('up-to-date', { head, behindBy: 0 });
    if (cycles >= maxCycles) {
      return out('cycle-cap', { head, behindBy: cmp.behindBy, message: `${base} kept moving: still ${cmp.behindBy} commit(s) behind after ${cycles} update(s)` });
    }

    const baseSha = cmp.baseSha;
    const res = gh.updateBranch(pr, head);
    if (res.result === 'conflict') {
      return out('rebase-needed', { head, message: `updating from ${base} conflicts (${res.message}): rebase or merge by hand; nothing was force-pushed` });
    }
    if (res.result === 'head-moved') {
      return out('head-moved', { head, message: `GitHub refused the update: ${res.message}. Someone pushed since ${head}; re-read the PR` });
    }
    cycles += 1;

    const next = await waitForNewHead({ gh, pr, from: head, waitMs: headWaitMs, pollMs, now, sleep });
    if (next === null) return out('head-timeout', { head, message: `GitHub accepted the update but the PR head did not change within ${Math.round(headWaitMs / 1000)}s` });
    const parents = gh.commitParents(next);
    if (parents.length !== 2 || parents[0] !== head || parents[1] !== baseSha) {
      return out('head-moved', { head: next, message: `the PR head became ${next}, which is not the merge of ${baseSha} into ${head} (parents: ${parents.join(', ') || 'none'}): someone pushed during the update; re-read, nothing more was written` });
    }
    updates.push({ headBefore: head, baseTip: baseSha });
    known = next;
    if (waitChecks) {
      const verdict = await waitForChecks({ gh, pr, waitMs: checksWaitMs, pollMs, now, sleep });
      if (verdict !== 'pass') {
        return out(verdict === 'fail' ? 'checks-failed' : 'checks-timeout', { head: next, message: `the updated head ${next} did not get green required checks (${verdict})` });
      }
    }
  }
}
