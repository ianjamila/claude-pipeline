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
import { DEFAULTS } from '../lib/config.mjs';
import { headSha, revParse } from '../lib/git.mjs';
import { admitRound, baseOnlyFindings, effortNoteText, headMoved, modelNoteFor, planRound, recordRound, roundPrompt, routeConfigFor, unavailable } from '../lib/review-round.mjs';
import { roundDir, writeFileAtomic } from '../lib/review-context.mjs';
import { createGitHub } from '../lib/github.mjs';
import { noteCodexAnswered, noteQuotaStop, recordCodexRun } from '../lib/codex-usage.mjs';
import { higherRisk, maxRiskOf } from '../lib/state.mjs';
import { substituteAgentFor } from '../lib/triage.mjs';
import {
  assertCurrentAttempt, finishAttempt, modelRefusalMessage, publishAttemptFiles, startAttempt, substituteEligibility, writeFinalRoute,
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
    '  review.effort.small_fix_lines, review.codex_round_budget, review.codex_budget.soft / .hard and review.substitute.mode / min_wait_minutes / max_packet_mb are each read as the stricter of the working-tree config and the config',
    '    committed at the fork point of the default branch (lower small_fix_lines and max_packet_mb, higher budgets and min_wait_minutes, mode off when either says off), so a PR cannot loosen them; an unreadable base config means mode off;',
    '    a mode-off plan or substitute verdict carries modeOffFrom: which config said off (the working tree, the base at the fork point, or an unreadable base with the reason)',
    '  review.effort.low|medium|high|followup|small_fix are each read as the HIGHER effort (low < medium < high < xhigh) of the working-tree config and the config at the fork point of the default branch (an unreadable base: held against the built-in lanes; a base config that names another default_branch than the working tree\'s, under a trusted anchor, still counts: the stricter of the working tree, that config and the built-in lanes), so a PR cannot lower its own review effort;',
    '    review.codex_model is the base config\'s (an unreadable base or an untrusted anchor: the built-in default), never the working tree\'s, and --model must name it, else exit 2 {error:model-mismatch, expected}; it is read at the fork point admission fetched (origin/<default branch>, refreshed best effort even when the PR\'s base is another branch, a stack), so this check follows admission',
    '  when GitHub names no base branch and the default branch cannot be anchored on the remote (an origin remote that answered neither origin/HEAD nor ls-remote: the working tree\'s default_branch is the PR\'s to edit), exit 3 {reason:github, error:unanchored-base}; with such an untrusted anchor the commits merged in from the base branch are never left out of a later round (the range is the previous round\'s head, kind previous)',
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
    '  exit 2 {error:stale-history | unpublished-history | history-unreadable} for a COUNTED round, before Codex runs (read again under the final lock): the PR\'s triage comment is the',
    '    published history. stale-history: this copy lacks a published round or owner grant (run `pipeline state show --pr N`); unpublished-history: this copy holds rounds the PR',
    '    lacks, an earlier publish failed (run `pipeline comment --pr N --kind triage`); history-unreadable: the comment holds no readable state. No triage comment: no check',
    '  reviewer: fable (medium/high risk, except medium for size only, or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired',
    '    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker\'s brief for the sensitive files; judge otherwise. Once fable, always fable.',
    '    The judge also reviews a medium PR that is medium ONLY for its size (no hard-stop hit of any kind, no sensitive path, base branch = the default branch) unless',
    '    review.size_only_medium_reviewer is fable; the output then has sizeOnly:true and laneNote. The rating uses the working-tree config AND the one committed at the',
    '    default branch\'s fork point (stricter wins; an unreadable one means fable). A PR that goes from judge to fable reviews the WHOLE PR in that round (kind whole-pr)',
    '  confirm fixed: an accepted item that a forced or Claude ruling marked implemented through files other than the one it names (state mark-implemented,',
    '    implementedVia other-files) is listed in the prompt of the next round that runs Codex (not a base-only one), with its original finding fenced as untrusted',
    '    text: Codex says whether it is really fixed and raises it again as BLOCKING when it is not. The round records round.confirmFixed:[ids] (absent when none)',
    '  commits merged in from the PR\'s base branch since the previous round are left out of the reviewed diff; a round that only merged them in',
    '    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}',
    '  when that merge conflicted and the resolution only chose lines the two sides already had, Codex reviews just the resolution:',
    '    {resolutionOnly:true, conflicted, conflictedCount}; the round is a real review but does not count toward the cap. Otherwise',
    '    the whole PR is reviewed as before (a counted round) and {resolutionIneligible:"<reason>"} says why the resolution was not',
    '    taken alone',
    '  exit 3 {ok:false, unavailable:true, reason: quota|model|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver. A Codex failure also carries',
    '    substitute:{eligible, why, agent, resetAt, waitUntil?}: eligible only for a real quota stop (Codex\'s own turn.failed event, confirmed by its session log when found) or a proven refused model (below) with',
    '    review.substitute.mode auto (the stricter of the working-tree and the fork-point config, as above); agent is substitute-fable once the PR was ever high risk (maxRisk), else substitute-opus; review.substitute.min_wait_minutes above 0 and a',
    '    reset within it gives eligible:false, waitUntil (default 0: never wait). A quota stop also carries quota:{proof: session-log|stream, resetAt, resetText}, and is noted',
    '    in the machine-wide Codex record (P codex-status: lastOutage, waiting); the next Codex answer for the PR clears it (best effort: a failure there is a warnings entry, never a failed round)',
    '  a REFUSED MODEL (reason model: a non-zero exit and a last turn.failed that is Codex\'s typed model_not_found error, status 400 or 404; a retired, renamed or unavailable review.codex_model) is substitute-eligible like a quota stop, with the same proof discipline and no owner step: eligible only when its session log is found and also says model_not_found for the model this run asked for, names a provider, and ONE confirmation run (the same codex command and effort in a fresh empty temp dir with the one-line prompt "Reply OK"; free, a 400 costs no quota; not recorded in the codex-usage ledger) is refused the same way with its own log, the same model and the same provider. The output then carries modelStop:{proven, proof, model, unproven?} and a message that says where review.codex_model is read from and how to fix it (on the default branch, then bring that fix into the branch so its fork point moves) followed by the real substitute verdict (why model | model-unproven | mode-off; an unreadable fork-point config says to repair it with an owner commit). route.json then holds {evidence:model, model: the TRUSTED review.codex_model string, provider, proof:session-log, confirm:{threadId}, promptSha256, errorEvent}: never a model name taken from the provider\'s message. A model stop is never retried and is not noted in the Codex quota record (codex-status); it is evidence for 2 hours',
    '  effortNote / modelNote (#445, only when they differ; in --plan, the round output and an exit-3 stop; never for a round that goes to a substitute): effortNote {workingTree, configured, lane, from: fork-point|anchored-fork-point|built-in} says the working tree\'s own review.effort lane would have given another effort than the one that runs (each lane is the higher of the working tree\'s and the fork point\'s, so a lower lane applies only once it is on the default branch), and the effort-mismatch message names it; modelNote says the working tree\'s review.codex_model is not used (a key it omits reads "unset (built-in default <m>)"): the round runs the fork point\'s model, or the built-in default when the base config is unreadable. An older pipeline copy renders an evidence kind it does not know (model) as "Codex quota"; there is no state version bump',
    '  a Codex timeout, or a failure whose last turn.failed says the model is at capacity, is retried once in total (same prompt, same attempt; capacity after a wait): retried:{reason:timeout|capacity}; a second timeout is exit 3 unavailable with timedOut:true, never a substitute; a second capacity failure keeps its usual classification (error); quota is never retried',
    '  every Codex attempt first replaces .review/round-R/route.json with {attemptId, evidence:pending, round, base, head, patchSha256, risk, agent, at} and keeps its files in',
    '    round-R/attempt-<attemptId>/ (codex-raw.json, prompt.md). The final evidence (quota | none) and a recorded round are written under the review lock and a per-PR route lock (review, then route; the pending record takes the route lock alone, so a held review lock never stops Codex from starting) only while route.json still',
    '    holds this attempt in pending, else exit 2 {error:superseded} (nothing written, nothing deleted); the winner\'s files are copied to round-R/. The file is written by this command only',
    '  every real Codex run (not a base-only round), answered or failed, adds one line to <home>/.claude/pipeline-state/codex-usage.jsonl (the weekly figure `pipeline summary` prints);',
    '    a ledger that cannot be written never fails the round: it adds warnings:[…] to the reply',
    '  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout, PIPELINE_CODEX_CAPACITY_RETRY_MS the 30 second wait before the capacity retry (tests)',
  ].join('\n'),
};

export { CODEX_TIMEOUT_MS };

// The plan as the command prints it (an unbounded line count, binary, is null).
const planOutput = (p) => ({
  route: p.route, evidence: p.evidence, effort: p.effort, why: p.why, round: p.round, base: p.base, wholePrOwed: p.wholePr, protected: p.protected, small: p.small,
  ...(p.lowered === undefined ? {} : { lowered: p.lowered }),
  ...(p.effortNote === undefined ? {} : { effortNote: p.effortNote }),
  ...(p.why.startsWith('mode-off') && p.modeOffFrom ? { modeOffFrom: p.modeOffFrom } : {}),
  budget: p.budget, governor: p.governor === null ? null : { usedPct: p.governor.usedPct, soft: p.governor.soft, hard: p.governor.hard, observedAt: p.governor.observedAt },
  facts: { changedLines: Number.isFinite(p.facts.changedLines) ? p.facts.changedLines : null, newFile: p.facts.newFile, sensitive: p.facts.sensitive },
});

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
  const { config, path: configPath } = await requireConfig(root);
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
  // The model is the TRUSTED one (the config at the default branch's fork point, else the built-in default: review-round.mjs#strictestRouteConfig), never the working tree's, which a PR
  // can edit; --model must name it too (#389). The SHAPE of the effort and of a --model is checked first (a usage error before anything runs); which model is the trusted one is only
  // known once admitRound has fetched the default branch (the PR's base, and the default branch itself when that is another one: a stack) and fixed the trusted fork point (a local
  // origin/<default> behind the remote would name an older model), so the model and the model-mismatch check come after it (R1-B2, R2-F1).
  const argsFor = (outPath, model) => {
    try {
      return buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath });
    } catch (err) {
      throw new UsageError(err.message);
    }
  };
  argsFor(path.join(dir, 'codex-raw.json'), values.model ?? DEFAULTS.review.codex_model);

  const adm = await admitRound({ root, config, ctx, pr, round, base, head });
  // The stricter of the working tree's and the trusted base config (a PR must not turn its own substitute on / shorten the wait / lower its own effort); its model is the trusted one.
  const sub = routeConfigFor(root, config, adm.rated.trustedFork);
  const trustedModel = sub.codexModel;
  const model = values.model ?? trustedModel;
  if (model !== trustedModel) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'model-mismatch', expected: trustedModel,
      message: `--model ${model} is not the configured Codex model: use --model ${trustedModel} or leave --model out (the model is review.codex_model of the pipeline.yml at the default branch's fork point, else the built-in default; the working-tree value is ignored)`,
    });
  }
  // The model that will run is checked for shape too, before the plan and before any attempt starts (a malformed codex_model committed at the default branch must not leave a pending route.json) (R2-F2).
  // (validateConfig refuses a malformed review.codex_model before this point; a malformed one at the fork point reads as an unreadable base, so this is defence in depth.)
  try {
    argsFor(path.join(dir, 'codex-raw.json'), model);
  } catch (err) {
    throw new UsageError(`${err.message}; the model comes from review.codex_model of the pipeline.yml at ${config.default_branch}'s fork point: fix it on ${config.default_branch}, then bring that fix into this branch`);
  }
  // #445: the working tree names another model than the one that runs (it is never used): say so; the round still runs.
  const modelNote = modelNoteFor({ config, configPath, trustedModel, codexModelFrom: sub.codexModelFrom });
  const { baseOnly, resolutionOnly, resolutionView, resolution, resolutionIneligible } = adm;
  const prompt = roundPrompt(adm);

  // Who reviews this round and at what effort (lib/review-route.mjs table). A base-only round asks nothing: no plan.
  const plan = adm.baseOnly ? null : planRound(adm, { env: ctx.env });
  if (planOnly) {
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, plan: plan === null ? { baseOnly: true, round, base: adm.review.base } : planOutput(plan), expectedEffort: plan?.effort ?? sub.effort.followup,
        ...(modelNote !== undefined && plan?.route !== 'substitute' ? { modelNote } : {}),
      },
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
  // (`sub`, above: the verdict on a substitute reads the same stricter config.)

  // The effort is the configuration's, not the caller's: a round that is a small fix-check (or runs while the weekly Codex governor is soft) is cheaper,
  // every other round keeps the normal effort. A round the budget / governor sends to the substitute never runs Codex, so the effort is not asked about.
  if (plan !== null && plan.route === 'codex' && effort !== plan.effort) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'effort-mismatch', expected: plan.effort, why: plan.why,
      message: `--effort ${effort} is not the configured effort for round ${round}: use --effort ${plan.effort} (${plan.why}; \`pipeline codex-review --plan\` prints it)${plan.effortNote === undefined ? '' : `; ${effortNoteText(plan.effortNote, config.default_branch)}`}`,
      ...(plan.effortNote === undefined ? {} : { effortNote: plan.effortNote }),
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
    attempt = await startAttempt({ root, pr, ctx, round, base, head, patchSha256, risk, agent: substituteAgentFor(risk) });
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
    args = argsFor(outPath, model);
  }

  // A failed run: the verdict on a substitute, the final evidence (compare-and-swap: a superseded attempt exits 2 here instead), the machine-wide record.
  const failed = async (reason, extra, { ran, detail } = {}) => {
    const verdict = substituteEligibility({
      reason, timedOut: ran?.timedOut === true, quota: ran?.quota, modelStop: ran?.modelStop, mode: sub.mode, modeOffFrom: sub.modeOffFrom, minWaitMinutes: sub.minWaitMinutes, agent: attempt.route.agent,
    });
    const quotaStop = reason === 'quota' && ran?.quota?.eligible === true;
    // A refused model (cp #431) is evidence only when execCodex proved it (session log + confirmation run): the evidence names the TRUSTED model string, never one from the provider's message.
    const modelStopProven = reason === 'model' && ran?.modelStop?.eligible === true;
    const final = modelStopProven
      ? {
        evidence: 'model', outcome: 'failed', reason: 'model', model, provider: ran.modelStop.provider,
        errorEvent: { type: 'turn.failed', message: ran.modelStop.message }, threadId: ran.modelStop.threadId ?? null, promptSha256, proof: ran.modelStop.proof, confirm: ran.modelStop.confirm,
      }
      : quotaStop
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
      ...(reason === 'model' ? { modelStop: { proven: modelStopProven, proof: ran.modelStop?.proof ?? null, model, ...(ran.modelStop?.unproven ? { unproven: ran.modelStop.unproven } : {}) }, message: modelRefusalMessage({ model, verdict, defaultBranch: config.default_branch }) } : {}),
      ...(ran?.retried ? { retried: ran.retried } : {}),
      ...(modelNote === undefined ? {} : { modelNote }),
      ...(plan?.effortNote === undefined ? {} : { effortNote: plan.effortNote }),
      ...(quotaStop || (reason === 'quota' && ran?.quota) ? { quota: { proof: ran.quota.proof, resetAt: ran.quota.resetAt, resetText: ran.quota.resetText } } : {}),
      substitute: verdict,
      ...(warnings.length + usageWarnings.length > 0 ? { warnings: [...warnings, ...usageWarnings] } : {}),
    });
  };

  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const usageWarnings = [];
  const askCodex = async () => {
    // execCodex removes whatever is at the output path first (so it can never be read as this run's answer; the mtime check in
    // readCodexAnswer is the second line of defence, the tree kill on timeout the third).
    writeFileAtomic(path.join(attempt.dir, 'prompt.md'), promptBytes);
    const ran = await execCodex({ root, env: ctx.env, args, promptBytes, outPath, requestedModel: model });
    // One line per real Codex run, kept or not (the weekly figure in the agent-log line); a ledger that cannot be written is a warning.
    const logged = recordCodexRun({
      kind: 'review', repo: adm.state?.repo || repoSlug(), pr, round, effort, model, ok: ran.ok, resolutionOnly,
    }, { env: ctx.env, ...(ctx.home ? { home: ctx.home } : {}) });
    if (!logged.ok) usageWarnings.push(logged.warning);
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
      routeLock: true, // compare (gate) and write (afterSave) of route.json under the route lock (R1-B2)
      gate: () => {
        pendingRoute = assertCurrentAttempt(root, round, attempt.attemptId);
        publishAttemptFiles(root, round, attempt.attemptId, ['prompt.md', 'codex-raw.json']);
      },
      afterSave: () => writeFinalRoute(root, round, pendingRoute, { evidence: 'none', outcome: 'recorded' }),
    }),
  });
  // Codex answered: the PR is no longer waiting for it and its last outage is over (best effort).
  const warnings = baseOnly ? [] : await noteCodexAnswered({ pr, repo: repoSlug, env: ctx.env });

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
      ...(modelNote === undefined ? {} : { modelNote }),
      ...(plan?.effortNote === undefined ? {} : { effortNote: plan.effortNote }),
      ...(warnings.length + usageWarnings.length > 0 ? { warnings: [...warnings, ...usageWarnings] } : {}),
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolutionView.conflicted, conflictedCount: resolution.conflictedCount } : {}),
      ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      ...(grantUsed === undefined ? {} : { grantUsed }),
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      reviewer: state.reviewer,
      ...(adm.rated.sizeOnly ? { sizeOnly: true } : {}),
      ...(adm.rated.note && state.reviewer === 'judge' ? { laneNote: adm.rated.note } : {}),
      reviewerReasons: state.rounds.at(-1)?.fableReasons ?? [],
      path: dir,
    },
  };
});
