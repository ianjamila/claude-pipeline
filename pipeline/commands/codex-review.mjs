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
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { FINDINGS_SCHEMA_PATH, buildCodexArgs, validateFindings } from '../lib/codex.mjs';
import { CODEX_TIMEOUT_MS, execCodex, readCodexAnswer } from '../lib/codex-exec.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { headSha, revParse } from '../lib/git.mjs';
import { admitRound, baseOnlyFindings, headMoved, recordRound, roundPrompt, unavailable } from '../lib/review-round.mjs';
import { roundDir, writeFileAtomic } from '../lib/review-context.mjs';

export const meta = {
  summary: 'run one Codex review round over base..head and record its findings',
  usage: [
    'pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]',
    '  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, reviewer, reviewerReasons, path}',
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
    '  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver',
    '  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)',
  ].join('\n'),
};

export { CODEX_TIMEOUT_MS };

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, round: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    effort: { type: 'string' }, model: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const baseRef = requireOption(values, 'base');
  const headRef = requireOption(values, 'head');
  const effort = requireOption(values, 'effort');
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
  const outPath = path.join(dir, 'codex-raw.json');
  const model = values.model ?? config.review.codex_model;
  let args;
  try {
    args = buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const adm = await admitRound({ root, config, ctx, pr, round, base, head });
  const { baseOnly, resolutionOnly, resolutionView, resolution, resolutionIneligible } = adm;
  const prompt = roundPrompt(adm);

  // The exact bytes Codex gets on stdin. Saved as round-<R>/prompt.md BEFORE Codex starts (so a timed-out or crashed round keeps it)
  // from this same buffer, and its sha256 goes into the round record: the hash is of what was sent, not of a re-serialisation.
  // A base-only round asks nothing, so it has neither.
  const promptBytes = Buffer.from(prompt, 'utf8');
  const promptSha256 = baseOnly ? undefined : createHash('sha256').update(promptBytes).digest('hex');

  // Runs Codex over the prepared prompt and returns its validated findings (every failure is an exit-3 Fail).
  const askCodex = async () => {
    // execCodex removes whatever is at the output path first (so it can never be read as this run's answer; the mtime check in
    // readCodexAnswer is the second line of defence, the tree kill on timeout the third).
    writeFileAtomic(path.join(dir, 'prompt.md'), promptBytes);
    const ran = await execCodex({ root, env: ctx.env, args, promptBytes, outPath });
    if (!ran.ok) throw unavailable(ran.reason, { code: ran.code, timedOut: ran.timedOut, detail: ran.detail });

    if (headSha(o) !== head) throw headMoved();

    let findings;
    try {
      findings = readCodexAnswer(outPath, ran.startedAt);
    } catch (err) {
      throw unavailable('malformed', { errors: [err.message] });
    }
    const checked = validateFindings(findings);
    if (!checked.ok) throw unavailable('malformed', { errors: checked.errors });

    return findings;
  };
  // A base-merge-only round has nothing to ask about: zero findings, and the round says why.
  const findings = baseOnly
    ? baseOnlyFindings()
    : await askCodex();

  const { items, state, grantUsed } = await recordRound({
    adm, findings, roundFields: { codexModel: model, ...(promptSha256 === undefined ? {} : { promptSha256 }) },
  });

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
      ...(resolutionOnly ? { resolutionOnly: true, conflicted: resolutionView.conflicted, conflictedCount: resolution.conflictedCount } : {}),
      ...(resolutionIneligible === undefined ? {} : { resolutionIneligible }),
      ...(grantUsed === undefined ? {} : { grantUsed }),
      preRuled: items.filter((i) => i.final).length,
      lightLane: state.lightLane,
      reviewer: state.reviewer,
      reviewerReasons: state.rounds.at(-1)?.fableReasons ?? [],
      path: dir,
    },
  };
});
