// The judge side of the review loop. `validate` takes the judge's JSON (from its transcript, never the agent's own
// say-so about where it came from), refuses anything that is not exactly one decision per pending item, applies it,
// and settles whatever the deterministic rules allow without the arbiter. `settle` records a test result, which
// outranks every opinion. `light-lane` closes out the untriaged WORTH CONSIDERING items of a small low-risk PR.
// `owner-ruling` records what the owner decided in chat about an item that was waiting for a human; `ruling-request` prints the
// line that asks the owner (it carries a digest of the findings' text, which `owner-ruling` checks again). `claude-ruling` records
// Claude's own ruling on such an item, within the limits of triage.mjs#claudeRulingRefusal (a dismissal of a critical item needs the
// second review's verdict already on the item). `second-review` runs the blind Codex check that verdict comes from (see secondReview below).
// `round-request` also shows what one more round would cost and recommends, from triage.mjs#deferEligibility, whether the accepted fixes could instead be taken out and filed as
// follow-ups; `defer-fixes` does that (see deferFixes below).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EXIT, UnavailableError, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { SECOND_REVIEW_SCHEMA_PATH, buildCodexArgs, buildSecondReviewPrompt } from '../lib/codex.mjs';
import { execCodex, readCodexAnswer } from '../lib/codex-exec.mjs';
import { baseConfigAt } from '../lib/config.mjs';
import { git, headSha, isAncestor, mergeBase, revParse, reviewContentHash, showFile } from '../lib/git.mjs';
import { matchAny } from '../lib/glob.mjs';
import { GhError, runShellAsync } from '../lib/proc.mjs';
import { findSubagentTranscript, proveModel, extractJsonBlock } from '../lib/transcript.mjs';
import { STATE_VERSION_CLAUDE, STATE_VERSION_DEFERRAL, saveState, updateItems, withStateVersion } from '../lib/state.mjs';
import { askSummary } from '../lib/round-ask.mjs';
import { gatherRoundStatus, reviewedDiff } from '../lib/round-status.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { grantIdOf, ownerGrantLookups, ownerGrantedRounds, ownerRuled, ownerRulingGap, rulingConfigDirHint } from '../hooks/lib/owner-go.mjs';
import {
  applyClaudeRuling, applyJudge, applyOwnerRuling, applyTestResult, asciiLine, claudeRulingRefusal, DECISIONS, deferEligibility, deferItemsInState, finalizeWithoutArbiter, isOwnerRuled,
  isProtectedFinal, markLightLane, reviewedRoundCount, roundAdmission, roundOutcome, rulingContentDigest, secondReviewRefusal, settleSecondReview, validateSecondReview, validateTriage,
} from '../lib/triage.mjs';
import {
  currentContentHash, ensureRoundDir, findItem, findRound, readFileOrFail, refreshBaseRef, requireState, reviewBaseRef, withStateLock, writeFileAtomic, writeJson,
} from '../lib/review-context.mjs';
import { establishBaseline, publishTriage } from '../lib/review-publish.mjs';

export const meta = {
  summary: 'apply the judge triage, settle disputed bugs with test results, close the light lane, ask for and record owner rulings made in chat, record Claude\'s own rulings, run the blind Codex second review',
  usage: [
    'pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)',
    'pipeline triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd CMD --test-file FILE [--repo DIR]',
    '  -> the CLI runs CMD in the repo itself (free-text evidence is not accepted): bug-disproved needs exit 0, bug-confirmed needs a failing exit; FILE must be a committed, clean test file at HEAD named in CMD',
    '  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented',
    '  -> a bug-disproved result on a security/auth/permissions/data item is still needsHuman',
    'pipeline triage light-lane --round R [--repo DIR]',
    'pipeline triage ruling-request --pr N --ids ID[,ID…] [--repo DIR]',
    '  -> {ok, line}: the LAST line of the reply that asks the owner to rule, `⚖️ Owner ruling needed #N: ID, ID · content <digest12> · repo owner/name`; the digest covers the text of exactly those items in the current review state (exit 1 for an unknown id, a --pr that is not the review state\'s, or a repository off github.com)',
    'pipeline triage round-request --pr N [--repo DIR]',
    '  -> {ok, line, k, n, head, rounds, cost, open, notClean, recommend, why, discard, summary, warnings}: the LAST line of the reply that asks the owner for ONE more review round past review.max_rounds, `🔁 Extra review round needed #N: round K · head <head12> · repo owner/name`',
    '     (k = the counted round it would be: reviewed rounds + 1, base-only and resolution-only rounds not counted; n = the round number to pass to codex-review --round; head = the checked-out HEAD)',
    '  -> everything but line, k, n and head is display only and decides nothing: rounds {reviewed, max, autoExtraUsed, ownerGranted, next}; cost {bookedUsd, reviewUsd, fableUsd, perRoundUsd, lastRound, lastRoundUsd} (the last two from cost.byRound, \`cost --round R\`: the newest counted round with a booking, else null) from the PR\'s run record (read-only; null with a warning when it cannot be read);',
    '     open [{id, round, bucket, category, severity: low|high, title, file}] = every item that keeps the review from clean; notClean = why, in plain words; recommend follow-up|extra-round, with why (follow-up exactly when `defer-fixes` would accept the',
    '     current state: every unreviewed accept is a low-severity judge/arbiter fix, nothing else is open, no owner grant is open); discard {anchor, count, commits} = the commits since the last reviewed head that deferring would take out; summary = 3-5 plain lines the reply',
    '     pastes ABOVE the line; warnings (a severity or config error shows the items as high and recommends extra-round, it never suppresses the line). Titles are untrusted text: one ASCII line each',
    '  -> commit, push and quick-verify first: the grant is for that head. The owner answers `extra round` (or `grant round K`, optionally with #N); the owner-go hook records it, and',
    '     `codex-review --round n` then claims it (see its usage). Exit 1 for label mode (no grant exists), a --pr that is not the review state\'s, a repository off github.com,',
    '     or a round that is already allowed (within review.max_rounds, the automatic extra round, or an open grant for this head)',
    'pipeline triage defer-fixes --pr N --ids ID[,ID…] --fix-head SHA --reason TEXT [--repo DIR]',
    '  -> {ok, deferred: [ids], rounds: [every round number holding a deferred item], published, next?}: closes the round limit without another round when the unreviewed fixes are all LOW severity. Each fix is taken out of the tree FIRST (the caller reverted',
    '     every commit since the last reviewed head, pushed and waited for CI); then those ACCEPTs become FOLLOW-UPs (final.by claude, cause round-cap, the overruled ACCEPT kept, the item-level roundCapDeferral {fixHead, reviewedHead, at}), published at once like claude-ruling.',
    '     Run `followups create --round R` for EACH returned round afterwards (a retry is safe: it de-duplicates by fingerprint). Every deferral is a labelled row of the merge Rulings block, so the owner\'s "merge" binds each one by name',
    '  -> only with owner_approval: chat; exit 1 (state untouched) unless ALL hold: the round limit is reached and nothing is pending, waiting for a human, open BLOCKING, unimplemented or owed a Fable pass, and no unspent owner grant exists for the next round at any head (the lookup is STRICT: a records folder or session file that cannot be read, a record file over the size limit or not a regular file, an unreadable repo-moves file, an unsafe consumed-grants folder, or a record whose provenance cannot be confirmed as the owner\'s, refuses too; a records folder that does not exist is no grant; round-request applies the same lookup to its follow-up recommendation);',
    '     --ids is exactly the set of accepts no round has reviewed, each low severity (non-BLOCKING; category performance, maintainability, testing, design, docs or other; its file in the reviewed diff, on no risk.high_risk_paths / review.arbiter_always_paths glob,',
    '     not the file of a BLOCKING or security ACCEPT) and each accepted by the judge or the arbiter (not the owner, Claude, a second review, a test or a cache copy; and no other accepted fix of ANY round is marked implemented unless it was marked before the last counted round began: `state mark-implemented` records the newest round number at the time as the item\'s implementedAfterRound, and a carried copy records the round before the one it sits in; a fix marked after that round, or a mark with no record, may be out of the reviewed head and refuses, so the round runs); the tree equals the last round\'s content (every commit since reverted; when the default branch was merged in and moved the content, record that update as a base-only round first: codex-review runs no Codex for it); --fix-head is an ancestor of HEAD, a descendant of the last REVIEWED head (the last round that is not a base-only one), and has other content than the reviewed one (it only points the follow-up issues at the removed fix); the reviewedHead the issues compare against is the comparison point whose merged-in default branch matches --fix-head\'s, so the compare shows just the fix: the NEWEST recorded round, base-only or not, whose head --fix-head descends from (the base-only round recorded before the fix was made, or the last reviewed head when the update is recorded only after the revert), or, when the default branch was merged in between the fix and the revert, the last round (the reverted tree carries that merge) or, when no round sits there, HEAD itself (only when its merge base with the default branch is --fix-head\'s and it is the head GitHub has for the PR; the compare may also show agent-log lines); with no match the first one and a `warnings` entry in the output;',
    '     and the state with the fixes deferred reads as a clean review. A severity or config error refuses. Claude cannot reopen a deferral (claude-ruling and second-review refuse it); it writes review state format version 3; the owner\'s owner-ruling can',
    'pipeline triage claude-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --pr N [--repo DIR]',
    '  -> {ok, round, id, final, published, next?}; records CLAUDE\'s decision (final.by claude, needsHuman false, the overruled final and the cause kept) for an item waiting for a human, or tightens a Claude dismissal',
    '  -> only with owner_approval: chat; exit 1 for label mode, a --pr that is not the review state\'s, an empty reason or one over 1000 characters, or a ruling the rules refuse (state untouched)',
    '  -> ACCEPT is always allowed (also for a judge/arbiter malfunction). FOLLOW-UP alone only for a non-BLOCKING, non-security item with a known cause; any REJECT, and any dismissal of a BLOCKING or security item,',
    '     needs a second review already on the item that also dismisses it at high confidence (the result is the stricter of the two). Refused: a dismissal through a model-proof / invalid-arbiter / invalid-judge',
    '     malfunction (re-run the judge/arbiter, or ACCEPT), a loosened ACCEPT (only the owner\'s typed ruling loosens), an implemented item, and anything settled by a test, the judge, the arbiter or the owner',
    '  -> the ruling is published at once, under the review lock (published: true): the triage comment is updated as a compare-and-swap on the state\'s content (lib/review-publish.mjs). When GitHub cannot be reached the ruling stands locally (published: false, next = the retry, `pipeline comment --kind triage`); when the PR holds a state this copy did not publish or restore it is published: false, publishError: \'stale-publication\' (run `pipeline state show --pr N`, then redo). It writes review state format version 2 (a state already at a higher version keeps it)',
    'pipeline triage second-review --round R --ids ID[,ID…] --pr N [--repo DIR]',
    '  -> {ok, round, verdicts:[{id, decision, confidence, reasoning, final}], forcedAccept:[ids], published, publishError?, next}; runs ONE Codex call (review.codex_model, effort high, read-only, fresh session) over a BLIND packet of the named items',
    '     and stores its verdict in each item (item.secondReview), for claude-ruling to read. The packet is built from the review state and git alone: the original finding (id, bucket, category, title, file, line, detail, the reviewer\'s reasoning),',
    '     the test evidence the CLI recorded, the pinned head, the PR title and risk, fenced as untrusted text; never the judge\'s, the arbiter\'s or Claude\'s reason or decision. Codex is told to verify the claims in the code, read-only',
    '  -> only with owner_approval: chat; each id must be an item of round R that waits for a human (final.needsHuman) with a cause that is not a judge/arbiter malfunction, is not implemented, is not a round-limit deferral and has no second review yet: anything else refuses the whole call naming the id (exit 1, state untouched)',
    '     (ONE second review per item: a second call refuses). Codex ACCEPT sets the final ACCEPT at once (final.forcedBy second-review; fix it); a dismissal leaves the final as it was: at high confidence claude-ruling may dismiss it (the stricter of the two stands), below high only ACCEPT (or the owner\'s typed ruling) is possible',
    '  -> the check runs under the review lock, Codex runs outside it, then the state is read again under the lock: nothing is recorded (exit 1) when HEAD moved, an item\'s final or finding text changed, or a verdict appeared meanwhile',
    '  -> exit 1 {ok:false, reason} for an answer that is not exactly one valid verdict per requested id (or no usable answer after Codex exited 0): nothing is stored, so run it again. exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|github} when Codex or GitHub could not deliver: state untouched, the PR waits (review-loop.md rule 2)',
    '  -> the prompt and the raw answer are kept as .review/round-R/second-review-<first id>.md and .json; the result is published like a Claude ruling (published / publishError / next as for claude-ruling); it writes review state format version 2 (a state already at a higher version keeps it); env PIPELINE_CODEX_TIMEOUT_MS as for codex-review',
    'pipeline triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --owner-quote TEXT [--pr N] [--repo DIR]',
    '  -> {ok, round, id, final, published: false, next}; records the OWNER\'s decision (final.by owner, needsHuman false, the exact quote and time, the overruled final kept) for an item that needs a human',
    '  -> only with owner_approval: chat; exit 1 for label mode, an item that is not waiting for a human and has no unimplemented Claude ruling (settled items are not reopened), a missing item, an empty reason or quote, or a --pr that is not the review state\'s',
    '  -> works on an already published round. ACCEPT still needs the fix and a later review round; FOLLOW-UP is filed by `followups create`; the quote is published in the triage comment and the final gate counts it as ownerMerge (the owner\'s "merge" is still needed)',
    '  -> the quote must be the WHOLE owner prompt that answered a reply ENDING with the line `triage ruling-request` printed (`⚖️ Owner ruling needed #N: ID[, ID…] · content <digest12> · repo owner/name`; the owner-go hook records it; any session, last 24 h; white space and case aside), and that answer must be nothing but decisions, `ID: accept|follow-up|reject` per asked id, the id always written (any other word decides nothing; over 1000 characters is not recorded); exit 1 otherwise, or when gh resolves the repository off github.com',
    '  -> the request is bound to the findings\' text: the digest is recomputed over ALL the ids of the request from the current review state and must equal the recorded one, so a rebuilt review that reuses an id for a changed finding (or a request in the old line shape, with no digest) cannot reuse the ruling; ask again with ruling-request',
    '  -> pass the owner\'s own words as --owner-quote, never a paraphrase; then re-post the triage comment NOW (`pipeline comment --pr N --kind triage`); until then the ruling is local only (`published: false`); `pipeline state show` restores the published state without it, except a ruling that overrules a published Claude / forced final or a published final waiting for a human, which it keeps (local-ahead) and warns about',
  ].join('\n'),
};

// agents/judge.md pins the judge to Sonnet at effort medium (low-risk rounds only; a Fable round has no judge).
const JUDGE_MODEL_PREFIX = 'claude-sonnet-';
const JUDGE_EFFORT = 'medium';

const forceArbiter = (env) => (env ?? process.env).PIPELINE_TEST_FORCE_ARBITER === '1';

function nonEmpty(values, name) {
  if (values[name] === '') throw new UsageError(`--${name} must not be empty`);
  return values[name];
}

// The judge's JSON comes from the transcript's final message. Proof failures are only recorded here (the judge's
// model is not a trust boundary: its decisions are re-checked by the rules and the arbiter); a transcript that cannot
// be found or read is exit 2 so the caller can retry once Claude Code has written it.
function judgeOutput(values, ctx) {
  if (values.file !== undefined) {
    return { text: readFileOrFail(path.resolve(ctx.cwd ?? process.cwd(), values.file), 'judge output'), judgeProof: null };
  }
  const tag = nonEmpty(values, 'from-tag');
  const maxAgeMs = intOption(values, 'max-age-ms', { min: 0 });
  const found = findSubagentTranscript({ tag, projectsDir: nonEmpty(values, 'projects-dir'), maxAgeMs });
  if (!found) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'not-found', message: `no recent subagent transcript tagged ${JSON.stringify(tag)}` });
  }
  const jsonlText = readFileOrFail(found.jsonlPath, 'transcript');
  const metaText = found.metaPath === null ? undefined : readFileOrFail(found.metaPath, 'meta');
  const proof = proveModel({
    jsonlText, metaText, expectModelPrefix: JUDGE_MODEL_PREFIX, expectEffort: JUDGE_EFFORT, expectAgentType: 'judge',
  });
  return {
    text: proof.finalAssistantText,
    judgeProof: { ok: proof.ok, transcript: found.jsonlPath, models: proof.models, efforts: proof.efforts, stopReasonMissing: proof.stopReasonMissing, finalVia: proof.finalVia, errors: proof.errors },
  };
}

function validate(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, 'from-tag': { type: 'string' }, file: { type: 'string' }, repo: { type: 'string' },
    'projects-dir': { type: 'string' }, 'max-age-ms': { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  if ((values['from-tag'] === undefined) === (values.file === undefined)) throw new UsageError('give exactly one of --from-tag or --file');
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => validateLocked(values, n, root, ctx));
}

function validateLocked(values, n, root, ctx) {
  const state = requireState(root);
  const round = findRound(state, n);
  // One reviewer layer after Codex: a Fable round's items are ruled by the Fable pass alone (arbiter needed/apply).
  if (round.fableRequired === true) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'fable-round',
      message: `round ${n} is reviewed by the Fable pass, not the judge: run \`arbiter needed --round ${n}\``,
    });
  }

  const { text, judgeProof } = judgeOutput(values, ctx);
  const invalid = (errors) => ({
    exitCode: EXIT.FAILED, output: { ok: false, round: n, errors, ...(judgeProof ? { judgeProof } : {}) },
  });
  let json;
  try {
    json = extractJsonBlock(text);
  } catch {
    return invalid(['no JSON found in the judge output']);
  }
  // Items that already have a final (a cached ruling, a test, the light lane) are not the judge's to decide.
  const pending = round.items.filter((i) => !i.final).map((i) => i.id);
  const checked = validateTriage(json, pending);
  if (!checked.ok) return invalid(checked.errors);

  const env = ctx.env ?? process.env;
  const items = finalizeWithoutArbiter(applyJudge(round.items, json), { lightLane: state.lightLane, force: forceArbiter(env) });
  const next = updateItems(state, n, items);
  const dir = ensureRoundDir(root, n);
  writeJson(path.join(dir, 'triage.json'), { triage: json, judgeProof });
  saveState(root, next);

  const counts = { ACCEPT: 0, 'FOLLOW-UP': 0, REJECT: 0 };
  for (const e of json.items) counts[e.decision] += 1;
  const triaged = new Set(json.items.map((e) => e.id));
  const after = items.filter((i) => triaged.has(i.id));
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      round: n,
      counts,
      settled: after.filter((i) => i.final).map((i) => i.id),
      unsettled: after.filter((i) => !i.final).map((i) => i.id),
      judgeProof,
    },
  };
}

// How long the proving test may run before the CLI gives up on it.
const SETTLE_TEST_TIMEOUT_MS = 10 * 60 * 1000;
// Last chars of the test output kept as evidence (the state caps it again when it is posted).
const OUTPUT_TAIL = 300;

const tailOf = (s, n) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `…${text.slice(-n)}` : text;
};

// Why a test result may not be recorded for this item, or null. A test settles a DISPUTE: the judge called the item a bug
// in dispute and said a test could decide it. It must not become a way to overrule a human's call, the arbiter, or
// something already built.
function settleRefusal(item, id) {
  if (item.final?.needsHuman === true) return `${id} needs a human decision; a test result cannot settle it`;
  if (item.final?.by === 'arbiter') return `${id} was already ruled by the arbiter`;
  if (isOwnerRuled(item)) return `${id} was already ruled by the owner`;
  if (isProtectedFinal(item)) return `${id} was ruled by Claude (or forced by a second review); a test result cannot settle it`;
  if (item.implemented === true) return `${id} is already implemented`;
  if ((item.test?.status ?? 'none') !== 'none') return `${id} already has a test result`;
  if (!(item.judge?.disputedBug === true && item.judge.settleTest?.possible === true)) {
    return `${id} is not a disputed bug with a possible settle test`;
  }
  return null;
}

// The pipeline runs the proving test itself; nothing the agent types is evidence. Throws Fail (exit 1) when the test
// cannot be trusted as proof; otherwise returns what was run.
async function runProvingTest({ root, config, result, cmd, file, id, round, env }) {
  const o = { cwd: root };
  const refuse = (reason) => new Fail(EXIT.FAILED, { ok: false, id, round, reason });
  if (!matchAny(file, config.integrity?.test_globs ?? [])) throw refuse(`--test-file ${file} is not a test file (integrity.test_globs)`);
  if (!cmd.includes(file)) throw refuse(`--test-cmd must run --test-file: ${JSON.stringify(file)} does not appear in the command`);
  // The file the command runs must be the one in the PR head, not an uncommitted edit.
  if (showFile('HEAD', file, o) === null) throw refuse(`--test-file ${file} is not in the PR head (commit the test first)`);
  if (git(['status', '--porcelain=v1', '-uall', '--', file], o) !== '') throw refuse(`--test-file ${file} has uncommitted changes; commit it so the run proves the PR head`);
  const head = headSha(o);
  const r = await runShellAsync(cmd, { cwd: root, env, timeoutMs: SETTLE_TEST_TIMEOUT_MS });
  if (r.timedOut) throw refuse(`the test command timed out after ${SETTLE_TEST_TIMEOUT_MS / 1000}s`);
  if (r.code === 126 || r.code === 127) throw refuse(`the test command could not be run (exit ${r.code}): ${tailOf(r.stderr || r.stdout, 200)}`);
  const passed = r.code === 0;
  // bug-disproved: the test (asserting correct behaviour) passes. bug-confirmed: that test fails, which is the bug.
  if (result === 'bug-disproved' && !passed) throw refuse(`bug-disproved needs the test to pass, but it exited ${r.code}: ${tailOf(r.stderr || r.stdout, 200)}`);
  if (result === 'bug-confirmed' && passed) throw refuse('bug-confirmed needs the test to fail, but it exited 0');
  const output = tailOf(`${r.stdout}\n${r.stderr}`, OUTPUT_TAIL);
  return { cmd, file, exitCode: r.code, head, evidence: `${file} (exit ${r.code}): ${output}` };
}

async function settle(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    id: { type: 'string' }, result: { type: 'string' }, 'test-cmd': { type: 'string' }, 'test-file': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const id = requireOption(values, 'id');
  const result = requireOption(values, 'result');
  if (result !== 'bug-confirmed' && result !== 'bug-disproved') throw new UsageError('--result must be bug-confirmed or bug-disproved');
  // A bare assertion is not evidence: the pipeline runs the test and records what it printed.
  const cmd = requireOption(values, 'test-cmd');
  const file = requireOption(values, 'test-file');
  if (cmd.trim() === '' || file.trim() === '') throw new UsageError('--test-cmd and --test-file must not be empty');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const env = ctx.env ?? process.env;

  // Check, then run the test WITHOUT the lock (it may take minutes), then check again and record under the lock.
  const preflight = await withStateLock(root, ctx, () => {
    const { round, item } = findItem(requireState(root), id);
    const reason = settleRefusal(item, id);
    return reason ? { exitCode: EXIT.FAILED, output: { ok: false, id, round: round.n, reason } } : { round: round.n };
  });
  if (preflight.exitCode !== undefined) return preflight;

  const proof = await runProvingTest({ root, config, result, cmd, file, id, round: preflight.round, env });

  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    const { round, item } = findItem(state, id);
    const reason = settleRefusal(item, id);
    if (reason) return { exitCode: EXIT.FAILED, output: { ok: false, id, round: round.n, reason } };
    const settled = applyTestResult(item, result, proof.evidence, proof);
    saveState(root, updateItems(state, round.n, [settled]));
    return { exitCode: EXIT.OK, output: { ok: true, id, round: round.n, test: settled.test, final: settled.final } };
  });
}

function lightLane(rest, ctx) {
  const { values } = parseCommandArgs(rest, { round: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => lightLaneLocked(n, root));
}

function lightLaneLocked(n, root) {
  const state = requireState(root);
  const round = findRound(state, n);
  // The shortcut skips triage of the WORTH CONSIDERING items, which is only acceptable for a small low-risk change.
  if (state.lightLane !== true) {
    return { exitCode: EXIT.FAILED, output: { ok: false, round: n, reason: 'this review is not on the light lane' } };
  }
  const items = markLightLane(round.items);
  const before = new Set(round.items.filter((i) => i.final).map((i) => i.id));
  saveState(root, updateItems(state, n, items));
  return {
    exitCode: EXIT.OK,
    output: { ok: true, round: n, marked: items.filter((i) => i.final && !before.has(i.id)).map((i) => i.id) },
  };
}

// What the owner said is recorded as said (trimmed only), with a cap so a pasted wall of text cannot bloat the published state.
const OWNER_TEXT_MAX = 1000;

// Why this ruling may not be recorded, or null. The command exists for ONE case: the owner confirmed in chat what to do with
// an item that is waiting for a human. It is not a way to reopen an item somebody already settled.
function ownerRulingRefusal(item, id, round) {
  if (item === undefined) return `no item ${id} in round ${round}`;
  // The owner may rule on an item waiting for a human, or (E6) override a Claude or forced final that is not implemented yet.
  const protectedFinal = isProtectedFinal(item);
  if (item.final?.needsHuman !== true && !protectedFinal) return `${id} does not need a human decision (an owner ruling cannot reopen a settled item)`;
  if (item.final?.needsHuman !== true && item.implemented === true) return `${id} is already implemented (an owner ruling cannot reopen it)`;
  return null;
}

async function ownerRuling(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, id: { type: 'string' }, decision: { type: 'string' }, reason: { type: 'string' },
    'owner-quote': { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const pr = intOption(values, 'pr', { min: 1 });
  const id = requireOption(values, 'id');
  const decision = requireOption(values, 'decision');
  if (!DECISIONS.includes(decision)) throw new UsageError(`--decision must be ${DECISIONS.join('|')}`);
  if (values.reason === undefined) throw new UsageError('missing --reason');
  if (values['owner-quote'] === undefined) throw new UsageError('missing --owner-quote');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (reason) => ({ exitCode: EXIT.FAILED, output: { ok: false, round: n, id, reason } });
  if (config.owner_approval !== 'chat') {
    return refuse('an owner ruling is recorded only with owner_approval: chat in pipeline.yml; in label mode the owner clears needs-human by label');
  }
  const reason = values.reason.trim();
  const ownerQuote = values['owner-quote'].trim();
  if (reason === '' || ownerQuote === '') return refuse('--reason and --owner-quote must not be empty: record the owner\'s own words');
  if (reason.length > OWNER_TEXT_MAX || ownerQuote.length > OWNER_TEXT_MAX) {
    return refuse(`--reason and --owner-quote are at most ${OWNER_TEXT_MAX} characters`);
  }

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (pr !== undefined && state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const item = findRound(state, n).items.find((i) => i.id === id);
    const why = ownerRulingRefusal(item, id, n);
    if (why) return refuse(why);
    // Phase 3b: the quote must be the owner's words, as the owner-go recorder wrote them down after a reply that asked for this ruling
    // (hooks/lib/owner-go.mjs presentedRuling): before, --owner-quote was the agent's own word. The repository is the one gh resolves on
    // github.com, as for "merge".
    const { slug, host } = gh.repo();
    const prNum = state.pr ?? pr;
    if (host !== 'github.com') return refuse(`gh resolves this repository on ${host ?? 'an unknown host'}, not github.com, and the owner's recorded ruling names a repository on github.com`);
    const asked = { repo: slug, pr: prNum, id, quote: ownerQuote, decision };
    if (!ownerRuled({ ...asked, contentOf: contentOfState(state) })) {
      const again = `ask again: end the reply with the line \`pipeline triage ruling-request --pr ${prNum} --ids ${id}\` prints (Owner rules in chat, review-loop.md), wait for the owner's answer, and pass all of it as --owner-quote`;
      // #110: the owner's answer exists but is bound to other text (or to none): say which.
      const gap = ownerRulingGap(asked);
      if (gap === 'provenance') return refuse(`an answer is recorded for ${slug} #${prNum} ${id}, but it cannot be confirmed as typed by the owner (its prompt is not in the transcript as the owner's, or came from a notice, another session or a scheduled turn, or was typed while the agent was still working${rulingConfigDirHint(asked) ? `; or ${rulingConfigDirHint(asked)}` : ''}), so it approves nothing; ${again}, and ask the owner to answer again (an answer typed while the agent was still working never counts: show the FRESH closing line \`ruling-request\` prints and ask once more after the reply ends)`);
      if (gap === 'no-content') return refuse(`the owner's ruling for ${slug} #${prNum} ${id} was asked with the old ruling line, which has no content digest, so it approves nothing; ${again}`);
      if (gap === 'changed') return refuse(`the finding text of ${id} (or of another item asked in the same request, or an item is gone) changed since the owner was asked, so the recorded ruling no longer applies; ${again}`);
      return refuse(`no owner ruling is recorded for ${slug} #${prNum} ${id} whose whole answer is --owner-quote and says ${decision.toLowerCase()} (an answer naming several decisions must also name ${id}): ${again}`);
    }
    seedBaseline({ ctx, root, pr: prNum, state }); // the `comment --kind triage` that publishes this ruling needs the baseline too
    const ruled = applyOwnerRuling(item, { decision, reason, ownerQuote, ruledAt: new Date().toISOString() });
    saveState(root, updateItems(state, n, [ruled]));
    const next = `run \`pipeline comment --pr ${state.pr ?? pr ?? '<N>'} --kind triage\` now: until the triage comment is re-posted the ruling is only local, and \`pipeline state show\` restores the published state without it unless it overrules a published Claude or forced final, or a published final waiting for a human (then it is kept as local-ahead)`;
    return { exitCode: EXIT.OK, output: { ok: true, round: n, id, final: ruled.final, published: false, next } };
  }, pr));
}

// Claude's own ruling (plan 2026-11-05-claude-rulings.md section 10). The rules are all in triage.mjs#claudeRulingRefusal / applyClaudeRuling; this
// checks what only the command can (mode, PR, the text), writes the state under the lock, and says what is left to publish.
// Publication (claude-ruling and second-review both end here), still under the review lock: the compare-and-swap of review-publish.mjs. The local
// result always stands. -> { published: true } when GitHub took it; { published: false, next } when GitHub could not be reached (`next` is the retry);
// { published: false, publishError: 'stale-publication', next } when the PR holds a state this copy neither published nor restored (run state show).
function publishRuling({ ctx, root, pr, state }) {
  try {
    publishTriage({ gh: createGitHub({ cwd: root, env: ctx.env }), root, pr, state });
    return { published: true };
  } catch (err) {
    if (err instanceof Fail && err.output?.error === 'stale-publication') {
      return { published: false, publishError: 'stale-publication', next: `NOT published: ${err.output.reason}. The decision is saved here only` };
    }
    if (err instanceof GhError || err instanceof UnavailableError) {
      return { published: false, next: `GitHub could not be reached, so the result is only local: run \`pipeline comment --pr ${pr} --kind triage\` when it is back (until then \`pipeline state show\` keeps a ruling that continues the published state, with a warning, and replaces one the PR has moved on from)` };
    }
    throw err;
  }
}

// Before a decision changes the state: a copy with no baseline whose state equals the published one gets its baseline (review-publish.mjs#establishBaseline), so the
// decision can publish. GitHub being unreachable leaves things as they are (the result is local and publishRuling says how to retry).
function seedBaseline({ ctx, root, pr, state }) {
  try {
    establishBaseline({ gh: createGitHub({ cwd: root, env: ctx.env }), root, pr, state });
  } catch (err) {
    if (!(err instanceof GhError || err instanceof UnavailableError)) throw err;
  }
}

async function claudeRuling(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, id: { type: 'string' }, decision: { type: 'string' }, reason: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const id = requireOption(values, 'id');
  const decision = requireOption(values, 'decision');
  if (!DECISIONS.includes(decision)) throw new UsageError(`--decision must be ${DECISIONS.join('|')}`);
  if (values.reason === undefined) throw new UsageError('missing --reason');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (reason) => ({ exitCode: EXIT.FAILED, output: { ok: false, round: n, id, reason } });
  if (config.owner_approval !== 'chat') {
    return refuse('a Claude ruling is recorded only with owner_approval: chat in pipeline.yml; in label mode the owner clears needs-human by label');
  }
  const reason = values.reason.trim();
  if (reason === '') return refuse('--reason must not be empty: say why');
  if (reason.length > OWNER_TEXT_MAX) return refuse(`--reason is at most ${OWNER_TEXT_MAX} characters`);

  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const item = findRound(state, n).items.find((i) => i.id === id);
    const why = item === undefined ? `no item ${id} in round ${n}` : claudeRulingRefusal(item, decision);
    if (why) return refuse(why);
    seedBaseline({ ctx, root, pr, state });
    const ruled = applyClaudeRuling(item, { decision, reason, ruledAt: new Date().toISOString() });
    // Format version 2 at least: an older pipeline must not read a state that holds a Claude ruling (state.mjs SUPPORTED_STATE_VERSION); a higher version stays.
    const next = withStateVersion(updateItems(state, n, [ruled]), STATE_VERSION_CLAUDE);
    saveState(root, next);
    return { exitCode: EXIT.OK, output: { ok: true, round: n, id, final: ruled.final, ...publishRuling({ ctx, root, pr, state: next }) } };
  }, pr);
}

// ---- second review (plan section 10.2) -------------------------------------------------------------------------------------------------

const SECOND_REVIEW_EFFORT = 'high';
const REASONING_MAX = OWNER_TEXT_MAX;
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Why this item may not be second-reviewed, or null: the library's rules (not implemented, no verdict yet, not a malfunction) plus the CLI's own:
// the item must still be waiting for a human, which is what the second review is for.
function secondReviewCheck(item, id, n) {
  if (item === undefined) return `no item ${id} in round ${n}`;
  const why = secondReviewRefusal(item);
  if (why) return why;
  if (item.final?.needsHuman !== true) return `${id} is not waiting for a human decision (a second review is for an item that needs one)`;
  return null;
}

// What the packet may carry of an item, picked field by field: the finding as raised and the test the CLI itself ran. Never item.judge, item.arbiter,
// item.final or anything Claude wrote.
const packetItem = (i) => ({
  id: i.id, bucket: i.bucket, category: i.category, title: i.title, file: i.file, line: i.line, detail: i.detail,
  ...(typeof i.codexReasoning === 'string' ? { codexReasoning: i.codexReasoning } : {}),
  ...(i.test ? { test: i.test } : {}),
});

// What must be the same when the verdict is recorded as when the question was asked: the head, every asked item's finding text (rulingContentDigest)
// and its final, and no verdict yet (secondReviewCheck again).
const askedSnapshot = (items) => ({ digest: rulingContentDigest(items), finals: JSON.stringify(items.map((i) => [i.id, i.final ?? null])) });

function secondReviewNext(verdicts) {
  const forced = verdicts.filter((v) => v.decision === 'ACCEPT').map((v) => v.id);
  const high = verdicts.filter((v) => v.decision !== 'ACCEPT' && v.confidence === 'high').map((v) => v.id);
  const low = verdicts.filter((v) => v.decision !== 'ACCEPT' && v.confidence !== 'high').map((v) => v.id);
  return [
    forced.length > 0 ? `${forced.join(', ')}: Codex says ACCEPT, so it is ACCEPT now (Claude cannot loosen it): fix it` : null,
    high.length > 0 ? `${high.join(', ')}: Codex dismisses it at high confidence, so claude-ruling may now dismiss it (the stricter of the two decisions stands)` : null,
    low.length > 0 ? `${low.join(', ')}: Codex dismisses it only below high confidence, so claude-ruling can only ACCEPT it (or the owner's typed ruling decides)` : null,
  ].filter(Boolean).join('; ');
}

async function secondReview(rest, ctx) {
  const { values } = parseCommandArgs(rest, { round: { type: 'string' }, ids: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const ids = [...new Set(requireOption(values, 'ids').split(/[\s,]+/).filter(Boolean))];
  if (ids.length === 0) throw new UsageError('--ids must name at least one item');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (reason, extra = {}) => ({ exitCode: EXIT.FAILED, output: { ok: false, round: n, reason, ...extra } });
  if (config.owner_approval !== 'chat') {
    return refuse('a second review is run only with owner_approval: chat in pipeline.yml; in label mode the owner clears needs-human by label');
  }
  const o = { cwd: root };
  const model = config.review.codex_model;

  // Check under the lock; the packet is built from the state and git right here.
  const asked = await withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const round = findRound(state, n);
    const items = [];
    for (const id of ids) {
      const item = round.items.find((i) => i.id === id);
      const why = secondReviewCheck(item, id, n);
      if (why) return refuse(why);
      items.push(item);
    }
    return { head: headSha(o), risk: state.risk, items: items.map(packetItem), snapshot: askedSnapshot(items) };
  }, pr);
  if (asked.exitCode !== undefined) return asked;

  const gh = createGitHub({ cwd: root, env: ctx.env });
  let title;
  try {
    title = gh.prView(pr, ['title']).title;
  } catch (err) {
    if (err instanceof GhError) throw new Fail(EXIT.UNAVAILABLE, { ok: false, unavailable: true, reason: 'github', message: err.message });
    throw err;
  }
  const prompt = buildSecondReviewPrompt({ pr, title, risk: asked.risk, head: asked.head, items: asked.items });
  const promptBytes = Buffer.from(prompt, 'utf8');
  const inputDigest = createHash('sha256').update(promptBytes).digest('hex');
  const dir = ensureRoundDir(root, n);
  const outPath = path.join(dir, `second-review-${ids[0]}.json`);
  let args;
  try {
    args = buildCodexArgs({ cwd: root, model, effort: SECOND_REVIEW_EFFORT, schemaPath: SECOND_REVIEW_SCHEMA_PATH, outPath });
  } catch (err) {
    throw new UsageError(err.message);
  }

  // Codex runs WITHOUT the lock (it can take minutes). The prompt is kept before it starts, so a crashed run still leaves what it was asked.
  writeFileAtomic(path.join(dir, `second-review-${ids[0]}.md`), promptBytes);
  const ran = await execCodex({ root, env: ctx.env, args, promptBytes, outPath });
  if (!ran.ok) {
    throw new Fail(EXIT.UNAVAILABLE, { ok: false, unavailable: true, reason: ran.reason, code: ran.code, timedOut: ran.timedOut, detail: ran.detail });
  }
  // From here on a bad answer stores nothing, so the call can simply be run again.
  let answer;
  try {
    answer = readCodexAnswer(outPath, ran.startedAt);
  } catch (err) {
    return refuse(`no usable Codex answer: ${err.message}; nothing was recorded, run second-review again`);
  }
  const checked = validateSecondReview(answer, ids);
  if (!checked.ok) return refuse(`the Codex answer is not one valid verdict per item: ${checked.errors.join('; ')}; nothing was recorded, run second-review again`, { errors: checked.errors });

  return withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    if (headSha(o) !== asked.head) return refuse('HEAD moved while Codex was reviewing; nothing was recorded, run second-review again');
    const round = findRound(state, n);
    const items = [];
    for (const id of ids) {
      const item = round.items.find((i) => i.id === id);
      const why = secondReviewCheck(item, id, n);
      if (why) return refuse(`${why} (it changed while Codex was reviewing); nothing was recorded`);
      items.push(item);
    }
    const now = askedSnapshot(items);
    if (now.digest !== asked.snapshot.digest) return refuse('a finding changed while Codex was reviewing; nothing was recorded, run second-review again');
    if (now.finals !== asked.snapshot.finals) return refuse('an item\'s final changed while Codex was reviewing; nothing was recorded, run second-review again');
    seedBaseline({ ctx, root, pr, state });
    const ranAt = new Date().toISOString();
    const byId = new Map(answer.items.map((e) => [e.id, e]));
    const settled = items.map((item) => {
      const e = byId.get(item.id);
      return settleSecondReview(item, { decision: e.decision, confidence: e.confidence, reasoning: clip(e.reasoning.trim(), REASONING_MAX), model, effort: SECOND_REVIEW_EFFORT, inputDigest, ranAt });
    });
    // Format version 2 at least: an older pipeline must not read a state that holds a second-review verdict (state.mjs SUPPORTED_STATE_VERSION); a higher version stays.
    const saved = withStateVersion(updateItems(state, n, settled), STATE_VERSION_CLAUDE);
    saveState(root, saved);
    const verdicts = settled.map((i) => ({ id: i.id, decision: i.secondReview.decision, confidence: i.secondReview.confidence, reasoning: i.secondReview.reasoning, final: i.final }));
    const { next: publishNext, ...published } = publishRuling({ ctx, root, pr, state: saved });
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, round: n, verdicts, forcedAccept: verdicts.filter((v) => v.decision === 'ACCEPT').map((v) => v.id), ...published,
        next: [secondReviewNext(verdicts), publishNext].filter(Boolean).join('. '),
      },
    };
  }, pr);
}

// #110: the digest of the findings the owner is asked about, for the items of the current review state (case-insensitive ids), or null when
// any is missing. owner-ruling hands it to ownerRuled, which calls it with the recorded request's FULL id list.
function itemsFor(state, ids) {
  const all = (state.rounds ?? []).flatMap((r) => r.items ?? []);
  const found = ids.map((id) => all.find((i) => String(i.id).toUpperCase() === String(id).toUpperCase()));
  return found.every(Boolean) ? found : null;
}
const contentOfState = (state) => (ids) => {
  const items = itemsFor(state, ids);
  return items ? rulingContentDigest(items) : null;
};

// The line that ends the reply asking the owner to rule: the CLI writes it, so the agent cannot state a digest of its own choosing.
async function rulingRequest(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, ids: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const ids = [...new Set(requireOption(values, 'ids').split(/[\s,]+/).filter(Boolean).map((id) => id.toUpperCase()))]; // (R1-B1 and r1-b1 are one item)
  if (ids.length === 0) throw new UsageError('--ids must name at least one item');
  const root = resolveRepo(values, ctx);
  const refuse = (reason) => ({ exitCode: EXIT.FAILED, output: { ok: false, reason } });
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const items = itemsFor(state, ids);
    if (items === null) {
      const missing = ids.filter((id) => itemsFor(state, [id]) === null);
      return refuse(`no item ${missing.join(', ')} in the review state`);
    }
    const { slug, host } = gh.repo();
    if (host !== 'github.com') return refuse(`gh resolves this repository on ${host ?? 'an unknown host'}, not github.com, and the owner's recorded ruling names a repository on github.com`);
    return { exitCode: EXIT.OK, output: { ok: true, line: `⚖️ Owner ruling needed #${pr}: ${items.map((i) => i.id).join(', ')} · content ${rulingContentDigest(items)} · repo ${slug}` } };
  }, pr));
}

// A lookup of the owner's extra-round records, shaped the way roundOutcome / deferEligibility take grants.
const asGrants = (lookup) => (ordinal) => lookup(ordinal).map((r) => ({ grantId: grantIdOf(r), head: r.head, quote: r.prompt }));

// The line that ends the reply asking the owner for one more review round: the CLI writes it (counted ordinal k, the checked-out head, the
// repository gh resolves on github.com), so the agent cannot ask for a round or a head of its own choosing. Chat mode only.
async function roundRequest(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (reason) => ({ exitCode: EXIT.FAILED, output: { ok: false, reason } });
  if (config.owner_approval !== 'chat') return refuse('an extra review round is granted only with owner_approval: chat in pipeline.yml; in label mode the agent parks');
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const { slug, host } = gh.repo();
    if (host !== 'github.com') return refuse(`gh resolves this repository on ${host ?? 'an unknown host'}, not github.com, and the owner's recorded grant names a repository on github.com`);
    const head = headSha({ cwd: root });
    const n = state.rounds.length + 1;
    const k = reviewedRoundCount(state) + 1;
    const grants = (ordinal) => ownerGrantedRounds({ repo: slug, pr, k: ordinal, anyHead: true }).map((r) => ({ grantId: grantIdOf(r), head: r.head, quote: r.prompt }));
    const { admission } = roundAdmission(state, n, { head, grants });
    if (admission !== null) {
      return refuse(admission === 'owner'
        ? `round ${k} is already granted for this head: run codex-review --round ${n}`
        : `round ${k} is already allowed (${admission === 'auto-extra' ? 'the automatic extra round' : 'within review.max_rounds'}): run codex-review --round ${n}`);
    }
    const line = `🔁 Extra review round needed #${pr}: round ${k} · head ${head.slice(0, 12)} · repo ${slug}`;
    // Everything below is display only: a failure in it is a warning, never a refusal and never a missing line (Codex R2 P2-4).
    const warnings = [];
    let shown = {};
    try {
      // The follow-up recommendation uses the STRICT lookups (an unreadable record refuses it, as defer-fixes does); the admission check above stays tolerant.
      const strict = ownerGrantLookups({ repo: slug, pr });
      shown = roundAskFields({ root, config, state, pr, gh, head, grants: asGrants(strict.grants), grantGap: strict.grantGap, warnings });
    } catch (err) {
      warnings.push(`the ask could not be summarised (${asciiLine(err?.message, 160)}): the line above still stands`);
    }
    return { exitCode: EXIT.OK, output: { ok: true, line, k, n, head, ...shown, warnings } };
  }, pr));
}

// The config committed at the default branch's fork point (the trusted one rateBranch also reads), for the union of the sensitive-path lists: a PR must not shrink its own list.
// -> { config, problem }: unreadable gives config null (its lists count as empty, nothing is loosened) and says why.
function trustedBaseConfig(root, config) {
  try {
    const base = baseConfigAt(mergeBase(reviewBaseRef(root, config), 'HEAD', { cwd: root }), root);
    return base.ok ? { config: base.config, problem: null } : { config: null, problem: base.reason };
  } catch (err) {
    return { config: null, problem: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
  }
}

// The display fields of the ask. `grants` is the same lookup the admission check used (any head); `grantGap` says why it found nothing ('provenance' = a record exists that cannot be
// confirmed as the owner's). A lookup that fails here degrades to a warning and the extra-round recommendation: it never loses the ask (`defer-fixes` itself refuses on it).
function roundAskFields({ root, config, state, pr, gh, head, grants, grantGap, warnings }) {
  const { rounds, cost, diff, since, open, notClean } = gatherRoundStatus({ root, config, state, pr, gh, warnings });
  let follow;
  try {
    const readable = (lookup) => (ordinal) => {
      try {
        return lookup(ordinal);
      } catch (err) {
        const w = `the owner's extra-round records could not be read (${asciiLine(err?.message, 120)}): the follow-up path is not offered`;
        if (!warnings.includes(w)) warnings.push(w);
        throw err;
      }
    };
    const trusted = trustedBaseConfig(root, config);
    if (trusted.problem) warnings.push(`the trusted base config could not be read (${asciiLine(trusted.problem, 120)}): only the working-tree sensitive paths are checked`);
    follow = deferEligibility(state, config, diff.files, { grants: readable(grants), grantGap: readable(grantGap), baseConfig: trusted.config });
  } catch (err) {
    follow = { eligible: false, refusals: [`severity could not be judged (${asciiLine(err?.message, 120)})`], ids: [], severities: [] };
    if (!warnings.some((w) => w.startsWith('severity could not be judged'))) warnings.push(follow.refusals[0]);
  }
  if (follow.eligible && since.anchor === null) follow = { ...follow, eligible: false, refusals: ['the commits since the last review could not be listed'] };
  const discard = { anchor: since.anchor, count: since.count, commits: since.commits };
  const { summary, why } = askSummary({ rounds, cost, open, notClean, follow, discard });
  return { rounds, cost, open, notClean, recommend: follow.eligible ? 'follow-up' : 'extra-round', why, discard, summary };
}

// `defer-fixes`: the safe alternative to an extra round when what is left is only low-severity accepted fixes (plan 2026-11-11-round-discipline-one-implementer.md, Item 1b).
// The rules are triage.mjs#deferEligibility (refusals 1, 2 and 5, on the state) plus the two that need git (3: the tree is back at the reviewed content, 4: --fix-head). Nothing is
// saved unless all pass. It is published at once, like a Claude ruling: the item changed from ACCEPT/implemented to FOLLOW-UP, which `state show` would not keep as unpublished work.
async function deferFixes(rest, ctx) {
  const { values } = parseCommandArgs(rest, { pr: { type: 'string' }, ids: { type: 'string' }, 'fix-head': { type: 'string' }, reason: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const ids = [...new Set(requireOption(values, 'ids').split(/[\s,]+/).filter(Boolean))];
  if (ids.length === 0) throw new UsageError('--ids must name at least one item');
  const fixHead = requireOption(values, 'fix-head').trim();
  if (values.reason === undefined) throw new UsageError('missing --reason');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const refuse = (reason, extra = {}) => ({ exitCode: EXIT.FAILED, output: { ok: false, reason, ...extra } });
  if (config.owner_approval !== 'chat') return refuse('deferring accepted fixes is allowed only with owner_approval: chat in pipeline.yml; in label mode the agent parks');
  const reason = values.reason.trim();
  if (reason === '') return refuse('--reason must not be empty: say why these fixes are low severity');
  if (reason.length > OWNER_TEXT_MAX) return refuse(`--reason is at most ${OWNER_TEXT_MAX} characters`);

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => withStateLock(root, ctx, () => {
    const state = requireState(root);
    if (state.pr !== pr) return refuse(`the review state is for PR #${state.pr}, not #${pr}`);
    const { slug, host } = gh.repo();
    if (host !== 'github.com') return refuse(`gh resolves this repository on ${host ?? 'an unknown host'}, not github.com, and the owner's recorded grants name a repository on github.com`);
    const last = state.rounds.at(-1);
    // The last round that REVIEWED something (a base-only round only carries that result to the merged-in content): the fallback anchor (see below).
    const lastReviewed = [...state.rounds].reverse().find((r) => r.baseOnly !== true) ?? last;
    const o = { cwd: root };
    // The owner's typed "extra round" always wins over a deferral, at whatever head it was typed for (the head moved when the fixes were reverted).
    // STRICT lookups (hooks/lib/owner-go.mjs#ownerGrantLookups): a record that cannot be read refuses, it never reads as "no grant".
    const strict = ownerGrantLookups({ repo: slug, pr });
    const grants = asGrants(strict.grants);
    const grantGap = strict.grantGap;
    const diff = reviewedDiff(root, config, state);
    if (diff.files === null) return refuse(`the reviewed diff could not be read (${diff.problem}), so no item can be judged low severity`);
    // Without the trusted base config the union of the sensitive-path lists is just the working tree's, which the PR may have shrunk: rateBranch
    // treats that as untrusted too (Fable), so severity cannot be judged here either.
    const trusted = trustedBaseConfig(root, config);
    if (trusted.problem) return refuse(`severity could not be judged: the trusted base config is unreadable (${asciiLine(trusted.problem, 160)}): fix .claude/pipeline.yml at the default branch's fork point, or ask the owner for an extra round`);
    let eligible;
    try {
      eligible = deferEligibility(state, config, diff.files, { grants, grantGap, baseConfig: trusted.config });
    } catch (err) {
      return refuse(`severity could not be judged (${asciiLine(err?.message, 160)}): fix the pipeline.yml lists, or ask the owner for an extra round`);
    }
    if (!eligible.eligible) return refuse(`the fixes cannot be deferred: ${eligible.refusals.join('; ')}`, { refusals: eligible.refusals });
    const want = [...eligible.ids].sort();
    const got = [...ids].sort();
    if (want.length !== got.length || want.some((id, i) => id !== got[i])) {
      return refuse(`--ids must be exactly the accepted fixes no round has reviewed (${want.join(', ')}), no more and no fewer (got ${got.join(', ')}); there is no partial defer`);
    }
    // Refusal 3: the tree is back at the reviewed content (the SAME anchor the coverage check uses).
    refreshBaseRef(root, config);
    const hash = currentContentHash(root, config);
    if (hash !== last.contentHashAtToHead) {
      let merged = false;
      try { merged = Number(git(['rev-list', '--merges', '--count', `${revParse(last.toHead, o)}..HEAD`], o)) > 0; } catch { /* the hint is optional */ }
      return refuse(`the tree is not back at the last reviewed content (head ${String(last.toHead).slice(0, 12)}): revert every commit made since then (fixes and anything else), push, run quick verify and wait for CI, then run defer-fixes again${merged ? '; the default branch was merged in since that head and moved the content: record that update as a base-only round first (codex-review for the new head, which runs no Codex), then run defer-fixes again' : ''}`);
    }
    // Refusal 4: --fix-head is a commit on this branch whose content is NOT the reviewed one (it points the follow-up issues at the removed fix; nothing else depends on it).
    let fixFull;
    try {
      fixFull = revParse(`${fixHead}^{commit}`, o);
    } catch {
      return refuse(`--fix-head ${asciiLine(fixHead, 60)} is not a commit in this repository`);
    }
    if (!isAncestor(fixFull, 'HEAD', o)) return refuse(`--fix-head ${fixFull.slice(0, 12)} is not an ancestor of HEAD`);
    // The fix descends from the last REVIEWED head: an older head would show the reviewed work in reverse in the issue's `git diff <anchor> <fix>` and the owner-bound Rulings row.
    if (!isAncestor(revParse(lastReviewed.toHead, o), fixFull, o)) return refuse(`--fix-head ${fixFull.slice(0, 12)} is older than the last reviewed head ${String(lastReviewed.toHead).slice(0, 12)}: pass the head that held the fixes (a descendant of the reviewed head)`);
    // The anchor (the reviewedHead the issue compares against): the NEWEST round, base-only or not, whose head the fix descends from, so the issue shows just the fix whether the default branch
    // was merged in before the fix (that base-only round) or only after the revert (a base-only round the fix does not descend from, so an older one). A head that no longer resolves is skipped.
    // When the default branch was merged in BETWEEN the fix and the revert, no round sits after that merge and above the fix, so that anchor lacks the merge and the issue's compare would show it (#287).
    // The right comparison point is the one with the same merged-in default branch as the fix head: compare each candidate's merge-base with the default branch against the fix head's.
    const descends = (r) => { try { return isAncestor(revParse(r.toHead, o), fixFull, o); } catch { return false; } };
    const ancestorAnchor = [...state.rounds].reverse().find(descends) ?? lastReviewed;
    const baseRef = reviewBaseRef(root, config);
    const baseOf = (rev) => { try { return mergeBase(baseRef, rev, o); } catch { return null; } };
    const fixBase = baseOf(fixFull);
    const warnings = [];
    let anchor = ancestorAnchor;
    // reviewedHead is what the issue compares the fix against; it is the anchor's head unless HEAD itself is the better point. Kept apart from the rounds the fixHash refusal below reads (no fake round).
    let reviewedHead = null;
    // HEAD (the revert, with the default branch merged in after the fix: no round sits there) is the comparison point when its merge base with the default branch is the fix head's AND it is the head
    // GitHub has for the PR. Refusal 3 above proved HEAD's content is the last reviewed content, so `git diff HEAD <fix>` is the fix; it can also show agent-log lines (the content hash excludes the agent log).
    const headIsPushedWithFixBase = () => {
      try {
        const head = revParse('HEAD', o);
        if (baseOf(head) !== fixBase) return false;
        const pushed = gh.prView(pr, ['headRefOid']).headRefOid;
        return typeof pushed === 'string' && pushed === head;
      } catch {
        return false; // the merge base or the PR head could not be read: no guess, the old anchor and its warning
      }
    };
    if (fixBase === null || baseOf(revParse(ancestorAnchor.toHead, o)) !== fixBase) {
      // the last round's own head (not HEAD: nothing says a round was recorded after the revert) carries the default branch merged in after the fix, and its content is the reviewed one
      let lastBase = null;
      try { lastBase = baseOf(revParse(last.toHead, o)); } catch { /* a head that no longer resolves is no comparison point */ }
      if (fixBase !== null && lastBase === fixBase) anchor = last;
      else if (fixBase !== null && headIsPushedWithFixBase()) reviewedHead = revParse('HEAD', o);
      else warnings.push(`the follow-up issues compare the removed fix with ${String(ancestorAnchor.toHead).slice(0, 12)}, but the default branch merged into the fix head is not the same one: the compare may show that merge too`);
    }
    const fixHash = reviewContentHash({ branch: config.default_branch, agentLog: config.agent_log, head: fixFull }, o);
    if ([last, anchor, lastReviewed].some((r) => fixHash === r.contentHashAtToHead)) {
      return refuse(`--fix-head ${fixFull.slice(0, 12)} has the reviewed content, so it is not the head that held the fixes: pass the head the round-request line named`);
    }
    seedBaseline({ ctx, root, pr, state });
    // Format version 3: a pre-deferral pipeline reads version 2 and would drop the deferral rows from the Rulings block and let Claude reopen them (state.mjs SUPPORTED_STATE_VERSION).
    const next = withStateVersion(deferItemsInState(state, want, { reason, ruledAt: new Date().toISOString(), fixHead: fixFull, reviewedHead: reviewedHead ?? anchor.toHead }), STATE_VERSION_DEFERRAL);
    saveState(root, next);
    const wanted = new Set(want);
    const rounds = next.rounds.filter((r) => (r.items ?? []).some((i) => wanted.has(i.id))).map((r) => r.n).sort((a, b) => a - b);
    return { exitCode: EXIT.OK, output: { ok: true, deferred: want, rounds, ...publishRuling({ ctx, root, pr, state: next }), ...(warnings.length ? { warnings } : {}) } };
  }, pr));
}

const SUBCOMMANDS = { 'defer-fixes': deferFixes, validate, settle, 'light-lane': lightLane, 'owner-ruling': ownerRuling, 'claude-ruling': claudeRuling, 'second-review': secondReview, 'ruling-request': rulingRequest, 'round-request': roundRequest };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline triage ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
