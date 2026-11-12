// One round of the cross-model review: runs the Codex CLI over `base..head`, validates what it wrote, gives every
// finding an id and appends the round to .review/state.json. The merge gate must never read "Codex failed" as
// "Codex found nothing", so every way this can go wrong (non-zero exit, timeout, no binary, no output file, a stale
// file, output that is not the schema) is exit 3 with `unavailable:true` and a reason; only a validated findings file
// (even an empty one) becomes a round.
//
// The range is not the caller's to choose. Round 1 must start at the merge base of the PR (so the review covers the
// whole PR and risk / light lane are measured on all of it); every later round must start where the previous one
// ended (so nothing between two rounds goes unreviewed). Anything else is exit 2 before Codex runs.
// What Codex is shown for a later round is that range minus whatever was merged in from the PR's base branch since the
// previous round (git.mjs#effectiveReviewBase): those commits were reviewed in their own PRs. A round that is nothing but
// such a merge is recorded as `baseOnly` without running Codex. When that merge conflicted and the resolver only chose lines
// the two sides already had (git.mjs#resolutionReviewBase proves it), the round is shown just the resolution and is recorded as
// `resolutionOnly`: a real review that does not count toward the round cap. The state is
// read-modified-written under the per-PR lock, but the lock is NOT held while Codex runs (up to 30 minutes): the
// state is read again under the lock once Codex has answered, and a round recorded in the meantime wins.
// The admission before Codex runs and the final locked write are the shared module pipeline/lib/review-round.mjs (admitRound / recordRound),
// so a second reviewer records a round through exactly the same code; this command is the Codex part: the prompt, running Codex, validating
// what it wrote.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { FINDINGS_SCHEMA_PATH, buildCodexArgs, validateFindings } from '../lib/codex.mjs';
import { CODEX_TIMEOUT_MS, execCodex, readCodexAnswer } from '../lib/codex-exec.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { headSha, revParse } from '../lib/git.mjs';
import { admitRound, baseOnlyFindings, headMoved, planRound, recordRound, roundPrompt, unavailable } from '../lib/review-round.mjs';
import { roundDir, writeFileAtomic } from '../lib/review-context.mjs';
import { createGitHub } from '../lib/github.mjs';
import { noteCodexAnswered, noteQuotaStop } from '../lib/codex-usage.mjs';
import { higherRisk, maxRiskOf } from '../lib/state.mjs';
import { substituteAgentFor } from '../lib/triage.mjs';
import {
  assertCurrentAttempt, finishAttempt, publishAttemptFiles, startAttempt, substituteEligibility, writeFinalRoute,
} from '../lib/route-record.mjs';

export const meta = {
  summary: 'run one Codex review round over base..head and record its findings',
  usage: [
    'pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]',
    'pipeline codex-review --pr N --round R --base SHA --head SHA --plan [--repo DIR]   -> {ok, plan, expectedEffort}',
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, reviewer, reviewerReasons, path}',
    '  --effort must be the configured effort for the round, else exit 2 {error:effort-mismatch, expected}: round 1 and a whole-PR round use review.effort.<risk> (low|medium|high), every later round review.effort.followup,',
    '    except that a small fix-check (the reviewed range is at most review.effort.small_fix_lines changed lines, adds no new file and touches no risk.high_risk_paths / review.arbiter_always_paths path) and, while the weekly Codex quota used is',
    '    at least review.codex_budget.soft, every other round that is not protected use review.effort.small_fix. Protected rounds always keep the normal effort: round 1, the first round after a maxRisk rise (or one that sees the rise),',
    '    a round with confirmFixed items, a resolution-only round, a whole-PR round that is owed. The round records effort; a round the governor lowered also records governor:{usedPct, threshold, observedAt} (state version 4)',
    '  --plan prints what the round would do and runs nothing, writes no route.json and no round: {ok, plan:{route: codex|substitute, evidence: none|budget|governor, effort, why, round, base, wholePrOwed, protected, small, lowered?, budget:{used, budget},',
    '    governor:{usedPct, soft, hard, observedAt}|null, facts:{changedLines, newFile, sensitive}}, expectedEffort}; the skill passes expectedEffort as --effort (--effort is optional with --plan)',
    '  a small fix-check (not protected, see above) goes to the substitute instead of Codex when the PR has used review.codex_round_budget Codex runs (recorded Codex rounds and recorded Codex second reviews in the state; a killed or retried run',
    '    does not count) or the weekly Codex quota used is at least review.codex_budget.hard (P codex-status; an unreadable figure turns the governor off). Codex is not run: exit 3 {ok:false, unavailable:true, reason:withheld, message,',
    '    substitute:{eligible:true, why: budget-spent|governor-hard, evidence: budget|governor, agent, resetAt:null}, plan}; route.json holds {evidence: budget, budget:{used, budget}} or {evidence: governor, governor:{usedPct, threshold, observedAt}}',
    '    with outcome withheld (valid for this attempt only). A larger round, or any protected round, stays on Codex however much was spent; review.substitute.mode off never substitutes',
    '  a whole-PR round is owed (state outcome wholePrOwed) when an Opus substitute round came before the PR\'s risk rose to high and no whole-PR round has run since: that round must use the PR\'s merge base as --base (else exit 2 base-mismatch),',
    '    reviews the whole PR (reviewBaseKind merge-base, never base-only or resolution-only, counts toward the cap) and records wholePr:true and patchSha256. An all-Codex history owes none',
    '  --base must be the PR\'s merge base for round 1 and the previous round\'s toHead after that, else exit 2 {error:base-mismatch}',
    '  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head, an empty commit,',
    '    an amend); the message names the accepted items still waiting for a fix, or says the content is what round N reviewed. Never for a round that only merged',
    '    the base branch in (below): that is recorded as baseOnly even when the content hash did not move',
    '  exit 2 {error:round-cap} past review.max_rounds, except ONE extra round when the last round only accepted fixes (state outcome extraRound)',
    '    or ONE round per owner grant (owner_approval: chat only): the owner typed "extra round" after a reply ending with the line triage round-request',
    '    printed, for this repository, PR, counted round and head (an owner record younger than 24 h; the automatic extra round is used first). The',
    '    grant is claimed AFTER Codex answered, under the final lock, as the last step before the state is saved, by exclusively creating a machine-global marker (one grant admits one run on',
    '    this machine): a grant already used, or recorded for another head ("ask again"), is exit 2 round-cap; Codex exit 3, head-moved and a kill before the claim',
    '    leave the grant open (a failure after the claim spends it: ask again). Success adds grantUsed:{grantId}; the round records admission and ownerGrant {grantId, k, quote, ownerTs}',
    '    base-only rounds and resolution-only rounds (below) never count toward the cap',
    '  reviewer: fable (medium/high risk or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired',
    '    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker\'s brief for the sensitive files; judge otherwise. Once fable, always fable',
    '  confirm fixed: an accepted item that a forced or Claude ruling marked implemented through files other than the one it names (state mark-implemented,',
    '    implementedVia other-files) is listed in the prompt of the next round that runs Codex (not a base-only one), with its original finding fenced as untrusted',
    '    text: Codex says whether it is really fixed and raises it again as BLOCKING when it is not. The round records round.confirmFixed:[ids] (absent when none)',
    '  commits merged in from the PR\'s base branch since the previous round are left out of the reviewed diff; a round that only merged them in',
    '    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}',
    '  when that merge conflicted and the resolution only chose lines the two sides already had, Codex reviews just the resolution:',
    '    {resolutionOnly:true, conflicted, conflictedCount}; the round is a real review but does not count toward the cap. Otherwise',
    '    the whole PR is reviewed as before (a counted round) and {resolutionIneligible:"<reason>"} says why the resolution was not',
    '    taken alone',
    '  redraftAdvice: a COUNTED round of a repo with ci.draft_while_iterating on a PR that is READY adds {redraftAdvice:true, warnings:[...]}: run `pipeline redraft --pr N` before',
    '    the first fix push (never a failure; a draft PR, a base-only or resolution-only round, or a PR that cannot be read gets no advice)',
    '  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver. A Codex failure also carries',
    '    substitute:{eligible, why, agent, resetAt, waitUntil?}: eligible only for a real quota stop (Codex\'s own turn.failed event, confirmed by its session log when found) with',
    '    review.substitute.mode auto; agent is substitute-fable once the PR was ever high risk (maxRisk), else substitute-opus; review.substitute.min_wait_minutes above 0 and a',
    '    reset within it gives eligible:false, waitUntil (default 0: never wait). A quota stop also carries quota:{proof: session-log|stream, resetAt, resetText}, and is noted',
    '    in the machine-wide Codex record (P codex-status: lastOutage, waiting); the next Codex answer for the PR clears it (best effort: a failure there is a warnings entry, never a failed round)',
    '  a Codex timeout is retried once (same prompt, same attempt): retried:{reason:timeout}; a second timeout is exit 3 unavailable with timedOut:true, never a substitute',
    '  every Codex attempt first replaces .review/round-R/route.json with {attemptId, evidence:pending, round, base, head, patchSha256, risk, agent, at} and keeps its files in',
    '    round-R/attempt-<attemptId>/ (codex-raw.json, prompt.md). The final evidence (quota | none) and a recorded round are written under the review lock only while route.json still',
    '    holds this attempt in pending, else exit 2 {error:superseded} (nothing written, nothing deleted); the winner\'s files are copied to round-R/. The file is written by this command only',
    '  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)',
  ].join('\n'),
};

export { CODEX_TIMEOUT_MS };

// The plan as the command prints it (an unbounded line count, binary, is null).
const planOutput = (p) => ({
  route: p.route, evidence: p.evidence, effort: p.effort, why: p.why, round: p.round, base: p.base, wholePrOwed: p.wholePr, protected: p.protected, small: p.small,
  ...(p.lowered === undefined ? {} : { lowered: p.lowered }),
  budget: p.budget, governor: p.governor === null ? null : { usedPct: p.governor.usedPct, soft: p.governor.soft, hard: p.governor.hard, observedAt: p.governor.observedAt },
  facts: { changedLines: Number.isFinite(p.facts.changedLines) ? p.facts.changedLines : null, newFile: p.facts.newFile, sensitive: p.facts.sensitive },
});

// true only when GitHub says the PR is a ready (non-draft) PR; a failed read, or any other answer, is false.
function prIsReady(gh, pr) {
  try {
    return gh.prView(pr, ['isDraft']).isDraft === false;
  } catch {
    return false;
  }
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, round: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    effort: { type: 'string' }, model: { type: 'string' }, repo: { type: 'string' }, plan: { type: 'boolean' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const baseRef = requireOption(values, 'base');
  const headRef = requireOption(values, 'head');
  const planOnly = values.plan === true;
  const effort = planOnly && values.effort === undefined ? 'medium' : requireOption(values, 'effort'); // --plan runs nothing: the effort is only echoed back checked
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const o = { cwd: root };

  // Full SHAs everywhere: they go into the prompt, the state and the round's recorded range.
  const base = revParse(`${baseRef}^{commit}`, o);
  const head = revParse(`${headRef}^{commit}`, o);
  if (headSha(o) !== head) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'head-mismatch',
      message: `--head ${head} is not the checked-out HEAD ${headSha(o)}: review the commit that is checked out`,
    });
  }

  const dir = roundDir(root, round);
  const model = values.model ?? config.review.codex_model;
  const argsFor = (outPath) => {
    try {
      return buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath });
    } catch (err) {
      throw new UsageError(err.message);
    }
  };
  argsFor(path.join(dir, 'codex-raw.json')); // a bad effort or model is a usage error before anything runs

  const adm = await admitRound({ root, config, ctx, pr, round, base, head });
  const { baseOnly, resolutionOnly, resolutionView, resolution, resolutionIneligible } = adm;
  const prompt = roundPrompt(adm);

  // Who reviews this round and at what effort (lib/review-route.mjs table). A base-only round asks nothing: no plan.
  const plan = adm.baseOnly ? null : planRound(adm, { env: ctx.env });
  if (planOnly) {
    return {
      exitCode: EXIT.OK,
      output: { ok: true, plan: plan === null ? { baseOnly: true, round, base: adm.review.base } : planOutput(plan), expectedEffort: plan?.effort ?? null },
    };
  }

  // The exact bytes Codex gets on stdin. Saved as round-<R>/prompt.md BEFORE Codex starts (so a timed-out or crashed round keeps it)
  // from this same buffer, and its sha256 goes into the round record: the hash is of what was sent, not of a re-serialisation.
  // A base-only round asks nothing, so it has neither.
  const promptBytes = Buffer.from(prompt, 'utf8');
  const promptSha256 = baseOnly ? undefined : createHash('sha256').update(promptBytes).digest('hex');

  // The repository's slug for the machine-wide Codex record (best effort: null when GitHub cannot say).
  const repoSlug = () => {
    if (adm.ghRepo?.slug) return adm.ghRepo.slug;
    if (adm.slug) return adm.slug;
    try {
      return createGitHub({ cwd: root, env: ctx.env }).repo().slug;
    } catch {
      return null;
    }
  };
  const sub = config.review.substitute;

  // The effort is the configuration's, not the caller's: a round that is a small fix-check (or runs while the weekly Codex governor is soft) is cheaper,
  // every other round keeps the normal effort. A round the budget / governor sends to the substitute never runs Codex, so the effort is not asked about.
  if (plan !== null && plan.route === 'codex' && effort !== plan.effort) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'effort-mismatch', expected: plan.effort, why: plan.why,
      message: `--effort ${effort} is not the configured effort for round ${round}: use --effort ${plan.effort} (${plan.why}; \`pipeline codex-review --plan\` prints it)`,
    });
  }

  // One attempt: route.json says 'pending' (and the attempt's files live in round-R/attempt-<id>/) before Codex starts. A base-only round asks nothing: no attempt.
  let attempt = null;
  let outPath;
  let args;
  if (!baseOnly) {
    // The agent is chosen by the highest risk the PR ever had (a shrinking diff never brings the cheaper reviewer back).
    const risk = adm.state ? higherRisk(maxRiskOf(adm.state), adm.level) : adm.level;
    const patchSha256 = createHash('sha256').update(readFileSync(path.join(dir, 'diff.patch'))).digest('hex');
    attempt = await startAttempt({ root, round, base, head, patchSha256, risk, agent: substituteAgentFor(risk) });
    // Budget / governor: Codex is not run; the evidence (valid for this attempt only) says why, and a substitute may stand in.
    if (plan.route === 'substitute') {
      const evidence = plan.evidence === 'budget'
        ? { evidence: 'budget', budget: { used: plan.budget.used, budget: plan.budget.budget } }
        : { evidence: 'governor', governor: { usedPct: plan.governor.usedPct, threshold: plan.governor.hard, observedAt: plan.governor.observedAt } };
      await finishAttempt({ root, pr, ctx, round, attempt, final: { ...evidence, outcome: 'withheld', reason: 'withheld', why: plan.why } });
      throw unavailable('withheld', {
        message: `Codex was not run: ${plan.why === 'budget-spent' ? `this PR has used its Codex budget (${plan.budget.used} of ${plan.budget.budget})` : `the weekly Codex quota is at ${plan.governor.usedPct}% (hard limit ${plan.governor.hard}%)`} and round ${round} is a small fix-check`,
        substitute: { eligible: true, why: plan.why, evidence: plan.evidence, agent: attempt.route.agent, resetAt: null },
        plan: planOutput(plan),
      });
    }
    outPath = path.join(attempt.dir, 'codex-raw.json');
    args = argsFor(outPath);
  }

  // A failed run: the verdict on a substitute, the final evidence (compare-and-swap: a superseded attempt exits 2 here instead), the machine-wide record.
  const failed = async (reason, extra, { ran, detail } = {}) => {
    const verdict = substituteEligibility({
      reason, timedOut: ran?.timedOut === true, quota: ran?.quota, mode: sub.mode, minWaitMinutes: sub.min_wait_minutes, agent: attempt.route.agent,
    });
    const quotaStop = reason === 'quota' && ran?.quota?.eligible === true;
    const final = quotaStop
      ? {
        evidence: 'quota', outcome: 'failed', reason: 'quota', resetAt: ran.quota.resetAt, resetText: ran.quota.resetText,
        errorEvent: { type: 'turn.failed', message: ran.quota.message }, threadId: ran.quota.threadId ?? null, promptSha256, proof: ran.quota.proof,
      }
      : { evidence: 'none', outcome: 'failed', reason, ...(ran?.timedOut ? { timedOut: true } : {}), ...(detail === undefined ? {} : { detail }) };
    await finishAttempt({ root, pr, ctx, round, attempt, final });
    const warnings = quotaStop
      ? await noteQuotaStop({ at: new Date(), resetAt: ran.quota.resetAt, resetText: ran.quota.resetText, repo: repoSlug(), pr, round, worktree: root, env: ctx.env })
      : [];
    return unavailable(reason, {
      ...extra,
      ...(ran?.retried ? { retried: ran.retried } : {}),
      ...(quotaStop || (reason === 'quota' && ran?.quota) ? { quota: { proof: ran.quota.proof, resetAt: ran.quota.resetAt, resetText: ran.quota.resetText } } : {}),
      substitute: verdict,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };

  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const askCodex = async () => {
    // execCodex removes whatever is at the output path first (so it can never be read as this run's answer; the mtime check in
    // readCodexAnswer is the second line of defence, the tree kill on timeout the third).
    writeFileAtomic(path.join(attempt.dir, 'prompt.md'), promptBytes);
    const ran = await execCodex({ root, env: ctx.env, args, promptBytes, outPath });
    if (!ran.ok) throw await failed(ran.reason, { code: ran.code, timedOut: ran.timedOut, detail: ran.detail }, { ran, detail: ran.detail });

    if (headSha(o) !== head) throw headMoved();

    let findings;
    try {
      findings = readCodexAnswer(outPath, ran.startedAt);
    } catch (err) {
      throw await failed('malformed', { errors: [err.message] }, { ran: { retried: ran.retried } });
    }
    const checked = validateFindings(findings);
    if (!checked.ok) throw await failed('malformed', { errors: checked.errors }, { ran: { retried: ran.retried } });

    return { findings, retried: ran.retried };
  };
  // A base-merge-only round has nothing to ask about: zero findings, and the round says why.
  const { findings, retried } = baseOnly
    ? { findings: baseOnlyFindings(), retried: undefined }
    : await askCodex();

  // The round is recorded only while route.json still holds this attempt (compare-and-swap under the review lock): else exit 2 superseded and nothing is written.
  let pendingRoute;
  const { items, state, grantUsed } = await recordRound({
    adm, findings, roundFields: {
      codexModel: model, ...(promptSha256 === undefined ? {} : { promptSha256 }),
      ...(plan === null ? {} : { effort }),
      // the governor lowered this round's effort: the decision is part of the round (and makes the state version 4)
      ...(plan?.lowered === 'governor-soft' ? { governor: { usedPct: plan.governor.usedPct, threshold: plan.governor.soft, observedAt: plan.governor.observedAt } } : {}),
      ...(adm.wholePr && attempt !== null ? { patchSha256: attempt.route.patchSha256 } : {}),
    },
    ...(attempt === null ? {} : {
      gate: () => {
        pendingRoute = assertCurrentAttempt(root, round, attempt.attemptId);
        publishAttemptFiles(root, round, attempt.attemptId, ['prompt.md', 'codex-raw.json']);
      },
      afterSave: () => writeFinalRoute(root, round, pendingRoute, { evidence: 'none', outcome: 'recorded' }),
    }),
  });
  // Codex answered: the PR is no longer waiting for it and its last outage is over (best effort).
  const warnings = baseOnly ? [] : await noteCodexAnswered({ pr, repo: repoSlug, env: ctx.env });

  // A COUNTED round of a repo that iterates in draft (ci.draft_while_iterating): if the PR is READY, every fix push of this round would re-run the heavy
  // CI, so say so now (the review skill's Rule 8: `pipeline redraft` before the first fix push). Advice only: an unreadable PR is no advice, never a failure.
  const redraftAdvice = config.ci.draft_while_iterating === true && !baseOnly && !resolutionOnly && prIsReady(createGitHub({ cwd: root, env: ctx.env }), pr);

  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      round,
      counts: {
        blocking: findings.blocking.length,
        suggestions: findings.suggestions.length,
        worth_considering: findings.worth_considering.length,
      },
      ...(baseOnly ? { baseOnly: true } : {}),
      ...(retried ? { retried } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolutionView.conflicted, conflictedCount: resolution.conflictedCount } : {}),
      ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      ...(grantUsed === undefined ? {} : { grantUsed }),
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      reviewer: state.reviewer,
      reviewerReasons: state.rounds.at(-1)?.fableReasons ?? [],
      path: dir,
      ...(redraftAdvice
        ? { redraftAdvice: true, warnings: [...warnings, `PR #${pr} is ready and this repo iterates in draft (ci.draft_while_iterating): run \`pipeline redraft --pr ${pr}\` BEFORE you push any fix from this round, so CI waits for the re-ready instead of running on every fix push`] }
        : {}),
    },
  };
});
