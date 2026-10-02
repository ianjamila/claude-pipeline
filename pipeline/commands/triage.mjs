// The judge side of the review loop. `validate` takes the judge's JSON (from its transcript, never the agent's own
// say-so about where it came from), refuses anything that is not exactly one decision per pending item, applies it,
// and settles whatever the deterministic rules allow without the arbiter. `settle` records a test result, which
// outranks every opinion. `light-lane` closes out the untriaged WORTH CONSIDERING items of a small low-risk PR.
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, headSha, showFile } from '../lib/git.mjs';
import { matchAny } from '../lib/glob.mjs';
import { runShellAsync } from '../lib/proc.mjs';
import { findSubagentTranscript, proveModel, extractJsonBlock } from '../lib/transcript.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import {
  applyJudge, applyTestResult, finalizeWithoutArbiter, markLightLane, validateTriage,
} from '../lib/triage.mjs';
import {
  ensureRoundDir, findItem, findRound, readFileOrFail, requireState, withStateLock, writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'apply the judge triage, settle disputed bugs with test results, close the light lane',
  usage: [
    'pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)',
    'pipeline triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd CMD --test-file FILE [--repo DIR]',
    '  -> the CLI runs CMD in the repo itself (free-text evidence is not accepted): bug-disproved needs exit 0, bug-confirmed needs a failing exit; FILE must be a committed, clean test file at HEAD named in CMD',
    '  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented',
    '  -> a bug-disproved result on a security/auth/permissions/data item is still needsHuman',
    'pipeline triage light-lane --round R [--repo DIR]',
  ].join('\n'),
};

const JUDGE_MODEL_PREFIX = 'claude-opus-';
const JUDGE_EFFORT = 'high';

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
    judgeProof: { ok: proof.ok, transcript: found.jsonlPath, models: proof.models, efforts: proof.efforts, errors: proof.errors },
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

const SUBCOMMANDS = { validate, settle, 'light-lane': lightLane };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline triage ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
