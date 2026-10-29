// The judge side of the review loop. `validate` takes the judge's JSON (from its transcript, never the agent's own
// say-so about where it came from), refuses anything that is not exactly one decision per pending item, applies it,
// and settles whatever the deterministic rules allow without the arbiter. `settle` records a test result, which
// outranks every opinion. `light-lane` closes out the untriaged WORTH CONSIDERING items of a small low-risk PR.
// `owner-ruling` records what the owner decided in chat about an item that was waiting for a human.
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, headSha, showFile } from '../lib/git.mjs';
import { matchAny } from '../lib/glob.mjs';
import { runShellAsync } from '../lib/proc.mjs';
import { findSubagentTranscript, proveModel, extractJsonBlock } from '../lib/transcript.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { ownerRuled } from '../hooks/lib/owner-go.mjs';
import {
  applyJudge, applyOwnerRuling, applyTestResult, DECISIONS, finalizeWithoutArbiter, isOwnerRuled, markLightLane, validateTriage,
} from '../lib/triage.mjs';
import {
  ensureRoundDir, findItem, findRound, readFileOrFail, requireState, withStateLock, writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'apply the judge triage, settle disputed bugs with test results, close the light lane, record owner rulings made in chat',
  usage: [
    'pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)',
    'pipeline triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd CMD --test-file FILE [--repo DIR]',
    '  -> the CLI runs CMD in the repo itself (free-text evidence is not accepted): bug-disproved needs exit 0, bug-confirmed needs a failing exit; FILE must be a committed, clean test file at HEAD named in CMD',
    '  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented',
    '  -> a bug-disproved result on a security/auth/permissions/data item is still needsHuman',
    'pipeline triage light-lane --round R [--repo DIR]',
    'pipeline triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --owner-quote TEXT [--pr N] [--repo DIR]',
    '  -> {ok, round, id, final, published: false, next}; records the OWNER\'s decision (final.by owner, needsHuman false, the exact quote and time, the overruled final kept) for an item that needs a human',
    '  -> only with owner_approval: chat; exit 1 for label mode, an item that is not waiting for a human (settled items are not reopened), a missing item, an empty reason or quote, or a --pr that is not the review state\'s',
    '  -> works on an already published round. ACCEPT still needs the fix and a later review round; FOLLOW-UP is filed by `followups create`; the quote is published in the triage comment and the final gate counts it as ownerMerge (the owner\'s "merge" is still needed)',
    '  -> pass the owner\'s own words as --owner-quote, never a paraphrase; then re-post the triage comment NOW (`pipeline comment --pr N --kind triage`); until then the ruling is local only (`published: false`) and `pipeline state show` restores the published state without it',
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
  if (item.final?.needsHuman !== true) return `${id} does not need a human decision (an owner ruling cannot reopen a settled item)`;
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
    if (!ownerRuled({ repo: slug, pr: prNum, id, quote: ownerQuote })) {
      return refuse(`no owner ruling is recorded for ${slug} #${prNum} ${id} whose words hold --owner-quote: end the reply that asks with \`⚖️ Owner ruling needed #${prNum}: ${id} · repo ${slug}\` (Owner rules in chat, review-loop.md), wait for the owner's answer, and pass words copied from it as --owner-quote`);
    }
    const ruled = applyOwnerRuling(item, { decision, reason, ownerQuote, ruledAt: new Date().toISOString() });
    saveState(root, updateItems(state, n, [ruled]));
    const next = `run \`pipeline comment --pr ${state.pr ?? pr ?? '<N>'} --kind triage\` now: until the triage comment is re-posted the ruling is only local, and \`pipeline state show\` restores the published state without it`;
    return { exitCode: EXIT.OK, output: { ok: true, round: n, id, final: ruled.final, published: false, next } };
  }, pr));
}

const SUBCOMMANDS = { validate, settle, 'light-lane': lightLane, 'owner-ruling': ownerRuling };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline triage ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
