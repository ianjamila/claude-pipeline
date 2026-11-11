// The judge side of the review loop. `validate` takes the judge's JSON (from its transcript, never the agent's own
// say-so about where it came from), refuses anything that is not exactly one decision per pending item, applies it,
// and settles whatever the deterministic rules allow without the arbiter. `settle` records a test result, which
// outranks every opinion. `light-lane` closes out the untriaged WORTH CONSIDERING items of a small low-risk PR.
// `owner-ruling` records what the owner decided in chat about an item that was waiting for a human; `ruling-request` prints the
// line that asks the owner (it carries a digest of the findings' text, which `owner-ruling` checks again). `claude-ruling` records
// Claude's own ruling on such an item, within the limits of triage.mjs#claudeRulingRefusal (a dismissal of a critical item needs the
// second review's verdict already on the item). `second-review` runs the blind Codex check that verdict comes from (see secondReview below).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EXIT, UnavailableError, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { SECOND_REVIEW_SCHEMA_PATH, buildCodexArgs, buildSecondReviewPrompt } from '../lib/codex.mjs';
import { execCodex, readCodexAnswer } from '../lib/codex-exec.mjs';
import { recordCodexRun } from '../lib/codex-usage.mjs';
import { git, headSha, showFile } from '../lib/git.mjs';
import { matchAny } from '../lib/glob.mjs';
import { GhError, runShellAsync } from '../lib/proc.mjs';
import { findSubagentTranscript, proveModel, extractJsonBlock } from '../lib/transcript.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { grantIdOf, ownerGrantedRounds, ownerRuled, ownerRulingGap, rulingConfigDirHint } from '../hooks/lib/owner-go.mjs';
import {
  applyClaudeRuling, applyJudge, applyOwnerRuling, applyTestResult, claudeRulingRefusal, DECISIONS, finalizeWithoutArbiter, isOwnerRuled, isProtectedFinal,
  markLightLane, reviewedRoundCount, roundAdmission, rulingContentDigest, secondReviewRefusal, settleSecondReview, validateSecondReview, validateTriage,
} from '../lib/triage.mjs';
import {
  ensureRoundDir, findItem, findRound, readFileOrFail, requireState, withStateLock, writeFileAtomic, writeJson,
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
    '  -> {ok, line, k, n, head}: the LAST line of the reply that asks the owner for ONE more review round past review.max_rounds, `🔁 Extra review round needed #N: round K · head <head12> · repo owner/name`',
    '     (k = the counted round it would be: reviewed rounds + 1, base-only and resolution-only rounds not counted; n = the round number to pass to codex-review --round; head = the checked-out HEAD)',
    '  -> commit, push and quick-verify first: the grant is for that head. The owner answers `extra round` (or `grant round K`, optionally with #N); the owner-go hook records it, and',
    '     `codex-review --round n` then claims it (see its usage). Exit 1 for label mode (no grant exists), a --pr that is not the review state\'s, a repository off github.com,',
    '     or a round that is already allowed (within review.max_rounds, the automatic extra round, or an open grant for this head)',
    'pipeline triage claude-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --pr N [--repo DIR]',
    '  -> {ok, round, id, final, published, next?}; records CLAUDE\'s decision (final.by claude, needsHuman false, the overruled final and the cause kept) for an item waiting for a human, or tightens a Claude dismissal',
    '  -> only with owner_approval: chat; exit 1 for label mode, a --pr that is not the review state\'s, an empty reason or one over 1000 characters, or a ruling the rules refuse (state untouched)',
    '  -> ACCEPT is always allowed (also for a judge/arbiter malfunction). FOLLOW-UP alone only for a non-BLOCKING, non-security item with a known cause; any REJECT, and any dismissal of a BLOCKING or security item,',
    '     needs a second review already on the item that also dismisses it at high confidence (the result is the stricter of the two). Refused: a dismissal through a model-proof / invalid-arbiter / invalid-judge',
    '     malfunction (re-run the judge/arbiter, or ACCEPT), a loosened ACCEPT (only the owner\'s typed ruling loosens), an implemented item, and anything settled by a test, the judge, the arbiter or the owner',
    '  -> the ruling is published at once, under the review lock (published: true): the triage comment is updated as a compare-and-swap on the state\'s content (lib/review-publish.mjs). When GitHub cannot be reached the ruling stands locally (published: false, next = the retry, `pipeline comment --kind triage`); when the PR holds a state this copy did not publish or restore it is published: false, publishError: \'stale-publication\' (run `pipeline state show --pr N`, then redo). It writes review state format version 2',
    'pipeline triage second-review --round R --ids ID[,ID…] --pr N [--repo DIR]',
    '  -> {ok, round, verdicts:[{id, decision, confidence, reasoning, final}], forcedAccept:[ids], published, publishError?, next}; runs ONE Codex call (review.codex_model, effort high, read-only, fresh session) over a BLIND packet of the named items',
    '     and stores its verdict in each item (item.secondReview), for claude-ruling to read. The packet is built from the review state and git alone: the original finding (id, bucket, category, title, file, line, detail, the reviewer\'s reasoning),',
    '     the test evidence the CLI recorded, the pinned head, the PR title and risk, fenced as untrusted text; never the judge\'s, the arbiter\'s or Claude\'s reason or decision. Codex is told to verify the claims in the code, read-only',
    '  -> only with owner_approval: chat; each id must be an item of round R that waits for a human (final.needsHuman) with a cause that is not a judge/arbiter malfunction, is not implemented and has no second review yet: anything else refuses the whole call naming the id (exit 1, state untouched)',
    '     (ONE second review per item: a second call refuses). Codex ACCEPT sets the final ACCEPT at once (final.forcedBy second-review; fix it); a dismissal leaves the final as it was: at high confidence claude-ruling may dismiss it (the stricter of the two stands), below high only ACCEPT (or the owner\'s typed ruling) is possible',
    '  -> the check runs under the review lock, Codex runs outside it, then the state is read again under the lock: nothing is recorded (exit 1) when HEAD moved, an item\'s final or finding text changed, or a verdict appeared meanwhile',
    '  -> exit 1 {ok:false, reason} for an answer that is not exactly one valid verdict per requested id (or no usable answer after Codex exited 0): nothing is stored, so run it again. exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|github} when Codex or GitHub could not deliver: state untouched, the PR waits (review-loop.md rule 2)',
    '  -> the prompt and the raw answer are kept as .review/round-R/second-review-<first id>.md and .json; the result is published like a Claude ruling (published / publishError / next as for claude-ruling); it writes review state format version 2; env PIPELINE_CODEX_TIMEOUT_MS as for codex-review',
    '  -> the Codex run is logged like a review round (kind second-review, <home>/.claude/pipeline-state/codex-usage.jsonl, see codex-review); a ledger that cannot be written adds warnings:[…] to the reply',
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
    // Format version 2: an older pipeline must not read a state that holds a Claude ruling (state.mjs SUPPORTED_STATE_VERSION).
    const next = { ...updateItems(state, n, [ruled]), version: 2 };
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
    return { head: headSha(o), repo: state.repo, risk: state.risk, items: items.map(packetItem), snapshot: askedSnapshot(items) };
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
  // The weekly Codex figure (codex-usage.mjs): one ledger line per real run; a ledger that cannot be written is only a warning.
  const logged = recordCodexRun({
    kind: 'second-review', repo: asked.repo || (() => { try { return gh.repo().slug; } catch { return null; } })(), pr, round: n, effort: SECOND_REVIEW_EFFORT, model, ok: ran.ok,
  }, { env: ctx.env, ...(ctx.home ? { home: ctx.home } : {}) });
  const usageWarnings = logged.ok ? [] : [logged.warning];
  if (!ran.ok) {
    throw new Fail(EXIT.UNAVAILABLE, { ok: false, unavailable: true, reason: ran.reason, code: ran.code, timedOut: ran.timedOut, detail: ran.detail, ...(usageWarnings.length ? { warnings: usageWarnings } : {}) });
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
    // Format version 2: an older pipeline must not read a state that holds a second-review verdict (state.mjs SUPPORTED_STATE_VERSION).
    const saved = { ...updateItems(state, n, settled), version: 2 };
    saveState(root, saved);
    const verdicts = settled.map((i) => ({ id: i.id, decision: i.secondReview.decision, confidence: i.secondReview.confidence, reasoning: i.secondReview.reasoning, final: i.final }));
    const { next: publishNext, ...published } = publishRuling({ ctx, root, pr, state: saved });
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, round: n, verdicts, forcedAccept: verdicts.filter((v) => v.decision === 'ACCEPT').map((v) => v.id), ...published,
        ...(usageWarnings.length ? { warnings: usageWarnings } : {}),
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
    return { exitCode: EXIT.OK, output: { ok: true, line: `🔁 Extra review round needed #${pr}: round ${k} · head ${head.slice(0, 12)} · repo ${slug}`, k, n, head } };
  }, pr));
}

const SUBCOMMANDS = { validate, settle, 'light-lane': lightLane, 'owner-ruling': ownerRuling, 'claude-ruling': claudeRuling, 'second-review': secondReview, 'ruling-request': rulingRequest, 'round-request': roundRequest };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline triage ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
