// `P merge --owner-go` merge-carry (plan 2026-11-05-merge-survives-main-reviewed, section 14 FINAL): the owner's "merge" for head H0, given WITH the Carry line, survives
// updates that only merge the base branch in. This is the loop that does the updating, entered by commands/merge.mjs only when the as-is path (today's evaluation at H0)
// failed for being behind its base ALONE and the owner's carry record for H0 exists. Held PRs never get here (C12). It holds the per-PR merge lock for the whole job (the
// caller) and the review lock only inside `final` (N2/C2). Per cycle (at most MAX_CARRY_CYCLES; "the base moved" starts the next one):
//   hold / label / default-branch checks (C7, F2) -> bringUpToDate (one update) -> fetch -> carriesApproval proof against GitHub's fresh baseRefOid -> advance the checkout (ff only)
//   -> refresh the review (base-only round + review-complete, never a real review) -> waitForCi pinned to the new head -> `final` = the complete evaluateOwnerGo + approval with
//   the carry proof re-made against the scan's own base + merge, under the review lock.
// Anything else than "the base moved" is terminal and says, in plain English, what stopped it and whether the owner's go is void (say "merge" again) or still stands (retry later).
// C10(a): after ANY merge-command invocation a retry needs abandonMerge to confirm auto-merge is off AND a re-read PR that is OPEN with no auto-merge request.
import { claimCheckout, advanceCheckout, verifyCheckout, releaseCheckout, readMarker } from './merge-job.mjs';
import { isPidAlive } from './locks.mjs';
import { bringUpToDate, updateTiming } from './updatebranch.mjs';
import { holdGate, holdsConfigured } from './merge-hold.mjs';
import { readEligibleHold } from './hold.mjs';
import { carriesApproval } from './approval-carry.mjs';
import { refreshReview } from './review-refresh.mjs';
import { ciReaders, ciWaitTiming, waitForCi } from './ci-wait.mjs';
import { loadConfig, requiredChecks } from './config.mjs';
import { abandonMerge, blockingLabelsOf, mergeTiming } from './finalgate.mjs';
import { NETWORK_TIMEOUT_MS, git } from './git.mjs';
import { EXIT } from './cli.mjs';
import { githubDefaultBranchOf } from './repo.mjs';

export const MAX_CARRY_CYCLES = 3;
const HOLD_OUTCOMES = new Set(['queued-behind', 'hold-unreadable']);
const short = (s) => String(s).slice(0, 12);
const realClock = () => ({ now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

// What GitHub says about a commit, as carriesApproval wants it.
export const commitInfoOf = (gh) => async (sha) => {
  const v = gh.commitVerification(sha);
  return { verified: v.verified, committerEmail: v.committerEmail };
};

/**
 * R1-B1: a merge job for `pr` died holding the checkout (its marker's pid is gone). GitHub is reconciled before anything is evaluated, for ANY outcome of the run: merged? still open with
 * auto-merge queued (it is disabled and must read back off)? Run by the --owner-go route before its first live evaluation and by the loop for a marker it replaced.
 * @returns {Promise<null | {merged: true, mergeSha: string|null, note: string} | {stop: string, code: string}>} null: nothing left to do, go on.
 */
export async function reconcileDeadJob({ gh, pr, root, config, env, disable, abandon = abandonMerge, log = () => {} }) {
  let view;
  try {
    view = gh.prView(pr, ['state', 'mergeCommit', 'autoMergeRequest']);
  } catch (err) {
    return { stop: `An earlier merge job for this PR died and GitHub could not be read to see what it left (${String(err?.message ?? err).slice(0, 160)}); nothing was updated.`, code: 'carry' };
  }
  if (view.state === 'MERGED') return { merged: true, mergeSha: view.mergeCommit?.oid ?? null, note: 'an earlier merge job for this PR had already merged it' };
  if (view.state !== 'OPEN') return { stop: `An earlier merge job died and the PR is ${view.state}; nothing was updated.`, code: 'carry' };
  if (view.autoMergeRequest) {
    const ab = await abandon({ gh, pr, cwd: root, env, pollMs: mergeTiming(config, env).pollMs, disable });
    if (ab.merged) return { merged: true, mergeSha: ab.mergeSha ?? null, note: 'an earlier merge job armed auto-merge and the PR merged while it was being disabled' };
    if (ab.autoMergeDisabled !== true || ab.readError) return { stop: 'An earlier merge job died with auto-merge armed and it could not be confirmed off: disable it by hand; nothing was updated.', code: 'carry-disarm' };
    log('an earlier job left auto-merge armed: disabled it');
  }
  return null;
}

/**
 * R2-F3: the dead marker belongs to ANOTHER PR (`dead`): reconcile that PR the same way, so an auto-merge it left armed is disarmed (or the run refuses naming it) instead of the marker being overwritten.
 * A merge of that PR is only logged: it is not this run's merge.
 * @returns {Promise<null | {stop: string, code: string}>}
 */
export async function reconcileOtherPrMarker({ gh, marker, root, config, env, disable, abandon, log = () => {} }) {
  const other = marker.pr;
  const r = await reconcileDeadJob({ gh, pr: other, root, config, env, disable, abandon, log });
  if (r?.stop) return { stop: `The dead merge job of PR #${other} (the marker in this checkout): ${r.stop}`, code: r.code };
  log(r?.merged ? `PR #${other}, whose merge job died here, is already merged` : `reconciled the dead merge job of PR #${other}`);
  return null;
}

/**
 * The top of the --owner-go route (R1-B1). A live marker of another process owns this checkout: busy. A dead marker for this PR is reconciled (reconcileDeadJob) and, once GitHub is settled, removed.
 * A dead marker of another PR is reconciled the same way through that PR (R2-F3, reconcileOtherPrMarker) before this PR's job may replace it.
 * @returns {Promise<null | {busy: string} | {merged: true, mergeSha: string|null, note: string} | {stop: string, code: string}>} null: go on.
 */
export async function recoverDeadJob({ gh, pr, root, config, env, disable, abandon, log }) {
  const marker = readMarker(root);
  if (marker === null) return null;
  if (marker.pid !== process.pid && isPidAlive(marker.pid)) return { busy: `another merge job (pid ${marker.pid}, PR #${marker.pr}) already owns this checkout` };
  if (marker.pr !== pr) {
    const other = await reconcileOtherPrMarker({ gh, marker, root, config, env, disable, abandon, log });
    if (other?.stop) return other;
    releaseCheckout({ root, marker });
    return null;
  }
  const dead = await reconcileDeadJob({ gh, pr, root, config, env, disable, abandon, log });
  if (dead?.stop) return dead;
  releaseCheckout({ root, marker }); // (GitHub is settled: merged, or open with nothing queued)
  return dead;
}

/**
 * R3-B2: GitHub's own auto-merge request is the durable record of an armed merge (a carry-disarm stop, or anyone arming it): while one is queued, the branch is not updated, because
 * the queued merge would land the new head before the proof, the review refresh and the final evaluation. Read before EVERY update and at the entry to the carry path.
 * @returns {null | {stop: string, code: 'carry-disarm'}} null: nothing queued, go on.
 */
export function armedAutoMerge({ gh, pr }) {
  let queued;
  try {
    queued = gh.prView(pr, ['autoMergeRequest']).autoMergeRequest;
  } catch (err) {
    return { stop: `GitHub could not be read to see whether auto-merge is queued (${String(err?.message ?? err).slice(0, 160)}), so the branch is not updated.`, code: 'carry-disarm' };
  }
  if (queued === null || queued === undefined) return null;
  return { stop: 'Auto-merge is armed on this PR (a merge command or someone else queued it), and an update now would let it land the new head before the proof and the review are redone: nothing was updated. Disable auto-merge (gh pr merge --disable-auto), then run it again.', code: 'carry-disarm' };
}

const VOID_NOTE = 'The owner\'s "merge" no longer covers what is on the PR: show the request again and wait for the owner to say "merge".';
const retryNote = (pr) => `The owner's "merge" still stands: run \`P merge --pr ${pr} --owner-go\` again later (the branch is already updated; nothing else changed).`;

/**
 * @param {{root: string, config: object, pr: number, gh: object, ctx: object, head: string, prefix: string,
 *   refuse: Function, holdRefuse: Function, final: (carried: object) => Promise<object>}} a
 *   head: the local HEAD (H0) the as-is path evaluated; prefix: the owner's recorded head prefix; final(carried): the review-locked last phase (commands/merge.mjs).
 *   ctx.carry (tests): { refreshReview, waitForCi, ciClock, abandon, disableAuto, log }
 */
export async function runCarryLoop(a) {
  const { root, pr, gh, ctx, refuse, holdRefuse, final, prefix } = a;
  let config = a.config; // reloaded from the checkout after every advance (X1): main may have changed the rules that judge this PR
  const env = ctx.env ?? process.env;
  const seam = ctx.carry ?? {};
  const log = seam.log ?? ((m) => process.stderr.write(`merge-carry: ${m}\n`));
  const stats = { from: a.head, to: a.head, cycles: 0, updates: 0 };
  const stop = (reason, { voids = false, code = 'carry', extra = {} } = {}) => refuse(code, [`${reason} ${voids ? VOID_NOTE : retryNote(pr)}`], { head: stats.to, carry: { ...stats }, goVoid: voids, ...extra });

  const claim = claimCheckout({ root, pr });
  if (!claim.ok) return stop(`The merge job could not take over this checkout (${claim.reason}); nothing was updated.`, { code: 'carry-checkout', extra: { checkout: claim.code } });
  let marker = claim.marker;
  try {
    // R1-F1: the claim records whatever HEAD / branch the checkout has NOW, after the review lock was released. It must be the head the as-is evaluation judged (a.head) on the PR's own branch, or a
    // checkout switched in that window (to a local main, say, which is an ancestor of the new head) would be fast-forwarded to the PR head. The go stands: nothing was touched.
    if (marker.expectedHead !== a.head) return stop(`The checkout moved from ${short(a.head)} to ${short(marker.expectedHead)} after the request was checked; nothing was updated.`, { code: 'carry-checkout', extra: { checkout: 'checkout-changed' } });
    let prBranch = null;
    try { prBranch = gh.prView(pr, ['headRefName']).headRefName ?? null; } catch { /* unknown: the head check above still binds the claim */ }
    if (typeof prBranch === 'string' && prBranch !== '' && prBranch !== marker.branch) return stop(`The checkout is on branch ${marker.branch}, not the PR's branch ${prBranch}; nothing was updated.`, { code: 'carry-checkout', extra: { checkout: 'checkout-changed' } });
    const mergedOut = (mergeSha, extra = {}) => ({
      exitCode: EXIT.OK,
      output: { ok: true, merged: true, mode: 'owner-go', head: stats.to, mergeSha: mergeSha ?? null, carried: { ...stats }, ...extra },
    });
    // §11.10: a previous job for this PR died holding the checkout: GitHub is reconciled before anything else (merged? auto-merge queued?).
    // (commands/merge.mjs already did this at the top of the route, so this only catches a job that died in between.)
    if (claim.replaced && claim.replaced.pr !== pr) { // R2-F3: only reachable when the marker died after the route's own check; the claim has already replaced it
      const other = await reconcileOtherPrMarker({ gh, marker: claim.replaced, root, config, env, disable: seam.disableAuto, abandon: seam.abandon, log });
      if (other) return stop(other.stop, { code: other.code });
    }
    if (claim.replaced && claim.replaced.pr === pr) {
      const dead = await reconcileDeadJob({ gh, pr, root, config, env, disable: seam.disableAuto, abandon: seam.abandon, log });
      if (dead?.merged) return mergedOut(dead.mergeSha, { note: dead.note });
      if (dead) return stop(dead.stop, { code: dead.code });
    }

    let cur = a.head; // the GitHub head the checkout holds (H(i-1))
    for (let cycle = 1; cycle <= MAX_CARRY_CYCLES; cycle += 1) {
      stats.cycles = cycle;
      log(`cycle ${cycle}/${MAX_CARRY_CYCLES}: checking before the update`);
      // C7 / C12 / F2: a hold or blocking label that appeared, a merge hold ahead, a base that is not the default branch.
      const held = await holdGate({ config, pr, root, env });
      if (held) return holdRefuse(held, { head: cur, carry: { ...stats } });
      const { hold } = await readEligibleHold({ gh, pr, config });
      let view = gh.prView(pr, ['state', 'labels', 'baseRefName']);
      const armed = armedAutoMerge({ gh, pr });
      if (armed) return stop(armed.stop, { code: armed.code, extra: { autoMergeDisabled: false } });
      if (hold !== null || blockingLabelsOf(view.labels).some((n) => n.toLowerCase() === 'needs-human')) {
        return stop('A needs-human hold appeared while the merge job was running, and a held PR never carries the owner\'s go.', { voids: true, code: 'carry-hold' });
      }
      if (blockingLabelsOf(view.labels).length > 0) return stop(`A blocking label appeared (${blockingLabelsOf(view.labels).join(', ')}).`);
      const defaultBranch = githubDefaultBranchOf(gh.repo());
      if (defaultBranch === null || view.baseRefName !== defaultBranch) return stop(defaultBranch === null ? 'GitHub did not name the repository\'s default branch, so the PR\'s base cannot be checked against it.' : `The PR now targets ${view.baseRefName}, not the default branch ${defaultBranch}.`, { voids: true, code: 'carry-base' });

      const synced = await bringUpToDate({
        gh, pr, expectHead: cur, maxCycles: 1, waitChecks: false, beforeUpdate: holdsConfigured(config) ? () => holdGate({ config, pr, root, env }) : null, ...updateTiming(env),
      });
      let capped = false;
      if (!synced.ok) {
        if (HOLD_OUTCOMES.has(synced.outcome)) return holdRefuse({ ...synced, error: synced.outcome }, { outcome: synced.outcome, head: cur, carry: { ...stats } });
        if (synced.outcome === 'cycle-cap') capped = true; // main moved again right after the update: it counts as "the base moved"
        else if (synced.outcome === 'rebase-needed') return stop(`The base branch does not merge into the PR cleanly (${synced.message}); someone has to resolve it by hand, which changes the PR.`, { voids: true, code: 'carry-conflict' });
        else if (synced.outcome !== 'head-moved') return stop(`The branch update did not finish (${synced.outcome}: ${synced.message ?? 'no detail'}).`, { extra: { outcome: synced.outcome } });
      }
      if (synced.updated) log(`updated the branch from ${config.default_branch}`);

      // C6 / d / e / f: whatever the head is on GitHub now, it is accepted only with the COMPLETE proof; the fetch is orchestration, the proof reads only.
      view = gh.prView(pr, ['headRefOid', 'baseRefOid', 'headRefName', 'baseRefName', 'state']);
      if (view.state !== 'OPEN') return stop(`The PR is ${view.state}.`);
      if (!synced.ok && synced.outcome === 'head-moved' && view.headRefOid === cur) return stop('GitHub refused the update because the head moved, but the head is unchanged: nothing more is done on a guess.');
      if (view.headRefOid !== cur) {
        try {
          git(['fetch', '--no-tags', 'origin', ...[view.headRefName, view.baseRefName].map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
          for (const sha of [view.headRefOid, view.baseRefOid]) git(['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
        } catch (err) {
          return stop(`The new head or the base could not be fetched (${String(err?.message ?? err).split('\n')[0].slice(0, 200)}).`);
        }
        const proof = await (seam.prove ?? carriesApproval)({ root, baseRefOid: view.baseRefOid, head: view.headRefOid, prefix, commitInfo: commitInfoOf(gh), home: seam.home });
        if (!proof.ok) return stop(`The new head ${short(view.headRefOid)} is not a clean, GitHub-made update of the approved head (${proof.reason}).`, { voids: true, code: 'carry-proof', extra: { proof: { code: proof.code } } });
        const adv = advanceCheckout({ root, marker, to: view.headRefOid });
        if (!adv.ok) return stop(`The checkout changed under the merge job (${adv.reason}).`, { voids: true, code: 'carry-checkout', extra: { checkout: adv.code } });
        marker = adv.marker;
        const loaded = await loadConfig(root);
        if (!loaded.ok) return stop(`The updated head has no valid .claude/pipeline.yml (${(loaded.errors ?? []).slice(0, 2).join('; ')}).`);
        config = loaded.config;
        cur = view.headRefOid;
        stats.to = cur;
        stats.updates = proof.steps.length;
        log(`proved ${short(cur)} is the approved head plus ${proof.steps.length} clean GitHub-made merge(s) of ${config.default_branch}; checkout advanced`);
      }
      if (capped) { log('main moved again; next cycle'); continue; }

      // g: carry the review to the new head (base-only round + review-complete); never a real review.
      // R1-B2: the base-only round is recorded before review-complete publishes it, so a failure of review-complete alone leaves the state half done. It is retried once here (the second call sees the round
      // already at this head and runs review-complete only); a second failure stops with the manual recovery named, and a retry of `P merge --owner-go` resumes it too (commands/merge.mjs).
      const refresh = () => (seam.refreshReview ?? refreshReview)({ root, config, pr, head: cur, ctx });
      let refreshed = await refresh();
      if (!refreshed.ok && refreshed.command === 'review-complete') refreshed = await refresh();
      if (!refreshed.ok) {
        const manual = refreshed.command === 'review-complete' ? ` The review round for ${short(cur)} is already recorded here; \`P review-complete --pr ${pr}\` finishes publishing it.` : '';
        return stop(`The review could not be carried to ${short(cur)} (${refreshed.code}: ${refreshed.reason}); stop and ask rather than guess.${manual}`, { extra: { refresh: { code: refreshed.code } } });
      }

      // h: CI of exactly this head.
      if (gh.prView(pr, ['headRefOid']).headRefOid !== cur) { log('the head moved before CI could be waited on; next cycle'); continue; }
      log(`waiting for CI on ${short(cur)}`);
      const ci = await (seam.waitForCi ?? waitForCi)({
        readers: ciReaders(gh, pr), options: { ...ciWaitTiming(env), waitAll: false, configChecks: requiredChecks(config.ci) }, clock: seam.ciClock ?? realClock(), onProgress: (l) => log(`ci: ${l}`),
      });
      const verdict = ci.output.verdict;
      if (verdict === 'head-moved' || verdict === 'base-changed') { log(`CI wait ended: ${verdict}; next cycle`); continue; }
      if (verdict !== 'passed' || ci.output.head !== cur) {
        const names = (ci.output.failures ?? ci.output.checks ?? []).filter((c) => c.state !== 'pass').map((c) => `${c.name}=${c.state}`);
        return stop(`CI on ${short(cur)} did not pass: ${verdict}${ci.output.message ? ` (${ci.output.message})` : ''}${names.length ? ` [${names.join(', ')}]` : ''}.`, { extra: { ci: { verdict, checks: names } } });
      }

      // i: the final phase under the review lock.
      const carried = { head: cur, config, verify: () => verifyCheckout({ root, marker }) };
      const result = await final(carried);
      if (result?.baseMoved === true) {
        if (result.commandRan === true) {
          // C10(a): the merge command ran, so auto-merge may be armed: no further update unless it is confirmed off AND the PR reads back open with nothing queued.
          const ab = result.abandoned;
          let back = null;
          try { back = gh.prView(pr, ['state', 'autoMergeRequest']); } catch { /* terminal below */ }
          if (!ab || ab.autoMergeDisabled !== true || ab.readError || ab.merged || back?.state !== 'OPEN' || back?.autoMergeRequest !== null) {
            return stop('The base moved after the merge command ran and it could not be confirmed that auto-merge is off and the PR still open with nothing queued: no further update is made. Check the PR by hand.', { code: 'carry-disarm', extra: { autoMergeDisabled: ab?.autoMergeDisabled === true } });
          }
        }
        log('main moved during the wait; next cycle');
        continue;
      }
      const out = result?.output ?? {};
      if (out.merged === true) { out.carried = { ...stats, to: out.head ?? stats.to }; return result; }
      const voids = ['owner-go', 'carry-hold', 'carry-checkout', 'carry-head'].includes(out.error);
      const note = voids ? VOID_NOTE : retryNote(pr);
      if (Array.isArray(out.reasons)) { out.reasons = [...out.reasons, note]; out.message = out.reasons.join('; '); } else if (typeof out.reason === 'string') out.reason = `${out.reason} ${note}`;
      out.carry = { ...stats };
      out.goVoid = voids;
      return result;
    }
    return stop(`The base branch kept moving: the branch was updated ${stats.updates} time(s) over ${MAX_CARRY_CYCLES} cycles and was still behind (cycle cap).`, { code: 'carry-cycle-cap' });
  } finally {
    releaseCheckout({ root, marker });
  }
}
