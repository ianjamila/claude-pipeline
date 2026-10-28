// The arbiter side of the review loop. `needed` decides (by the deterministic rules, never a model) which items go to
// the arbiter and writes the one input file it reads, stamped with a digest of its body. `apply` then PROVES from
// Claude Code's own transcript that Fable (and nothing else) answered that exact input, and only then lets the
// rulings count. Anything unproven or unparseable marks every arbitrated item needsHuman: a ruling that cannot be
// shown to come from the pinned model must not steer the decision.
//
// A Fable review round (the round has `fableRequired`: the PR is medium/high risk or touches a sensitive path) is the other
// mode of the same two steps: `needed` ALWAYS sends the round to Fable, even with zero Codex items, with the diff to review
// (the whole PR the first time, the round's slice after a proven Fable round) pinned by its digest; `apply` also takes
// Fable's own `findings` as new items. Until a proven pass is applied the round is not clean (triage.mjs#fablePendingRounds),
// so an unproven or missing Fable review can never pass as "nothing found".
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { fingerprint, largeBinaryNote } from '../lib/codex.mjs';
import { GitError, reviewPatch, showFile } from '../lib/git.mjs';
import { seamFlag } from '../lib/proc.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import { extractJsonBlock, findSubagentTranscript, proveModel } from '../lib/transcript.mjs';
import {
  applyRulings, arbiterNeeded, fableFindingItems, finalizeWithoutArbiter, isOwnerRuled, validateRulings,
} from '../lib/triage.mjs';
import {
  ensureRoundDir, excerptWindow, findRound, oneLine, patchRound, readFileOrFail, requireState, roundDir, sha256,
  withStateLock, writeFileAtomic, writeJson,
} from '../lib/review-context.mjs';

export const meta = {
  summary: 'decide which items need the arbiter, then prove and apply its rulings',
  usage: [
    'pipeline arbiter needed --round R [--force] [--repo DIR]',
    '  -> {needed:false, items:[], mode} | {needed:true, mode, items, inputPath, digest, digest8, tag, promptHeader[, diffPath, scope]}',
    '  mode review (a Fable round: medium/high risk or a sensitive path): always needed, even with zero items, until a proven pass is applied',
    '    (then {needed:false, done:true}); the input carries the diff to review (scope whole-pr the first time, round after that)',
    '  mode dispute (a judge round): only the items the dispute rules send; {needed:false} when there are none',
    '  start the arbiter prompt with promptHeader, pasted verbatim (the two lines ROUND: / INPUT-DIGEST:): without them `arbiter apply` cannot prove the arbiter saw this input and marks every item needsHuman',
    'pipeline arbiter apply --round R [--tag TAG | --agent-id ID] [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  the proof is pinned to claude-fable- at effort high; --expect-model / --expect-effort are honoured only with PIPELINE_TEST_MODE=1 in a repo checkout (an installed copy ignores it)',
    '  -> {ok, round, tag, transcript, errors, items[, findings]}; exit 0 proven + applied, 1 unproven (every arbitrated item needsHuman), 2 no transcript',
    '  mode review: the answer must also carry `findings` (Fable\'s own review, [] when clean); proven findings become items R<n>-F<k>;',
    '    unproven ones are kept in rulings.json as `unverifiedFindings` and the round stays Fable-pending (run needed + the arbiter again)',
  ].join('\n'),
};

export const DEFAULT_EXPECT_MODEL = 'claude-fable-';
export const DEFAULT_EXPECT_EFFORT = 'high';

const forceArbiter = (env) => (env ?? process.env).PIPELINE_TEST_FORCE_ARBITER === '1';
// Only the test suite may point the proof at another model or effort; a normal run is always pinned (spec R13).
// (and only from the repo checkout: an installed copy ignores it, see proc.mjs#seamValue)
const testMode = (env) => seamFlag('PIPELINE_TEST_MODE', env);

function nonEmpty(values, name) {
  if (values[name] === '') throw new UsageError(`--${name} must not be empty`);
  return values[name];
}

// ---- needed ---------------------------------------------------------------------------------

// A backtick fence longer than any backtick run in the text cannot be closed from inside it.
function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function excerptBlock(item, root) {
  if (!item.file) return '_No file given._';
  let content = null;
  try {
    content = showFile('HEAD', item.file, { cwd: root });
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
  }
  if (content === null) return `_${oneLine(item.file)} does not exist at HEAD._`;
  const w = excerptWindow(content, item.line, { maxLines: 2 * 20 + 1 });
  if (!w) return `_No code at line ${item.line} of ${oneLine(item.file)}._`;
  const width = String(w.end).length;
  const body = w.lines.map((text, i) => `${String(w.start + i).padStart(width)} | ${text}`).join('\n');
  const f = fence(body);
  return [`Code at HEAD, ${oneLine(item.file)} lines ${w.start}-${w.end}:`, '', `${f}`, body, f].join('\n');
}

function itemSection(item, root) {
  const where = item.file ? (item.line > 0 ? `${item.file}:${item.line}` : item.file) : '(no file)';
  const j = item.judge;
  const t = item.test ?? { status: 'none', evidence: '' };
  const judge = j
    ? `${j.decision} (confidence ${j.confidence}) - ${oneLine(j.reason)}${j.disputedBug ? ` [disputed bug; settle test ${j.settleTest?.possible ? 'possible' : 'not possible'}]` : ''}`
    : 'not triaged';
  return [
    `## ${item.id}`,
    '',
    `- Bucket: ${item.bucket}`,
    `- Category: ${item.category}`,
    `- Title: ${oneLine(item.title)}`,
    `- Location: ${oneLine(where)}`,
    `- Judge: ${judge}`,
    `- Test result: ${t.status === 'none' ? 'none' : `${t.status} - ${oneLine(t.evidence)}`}`,
    '',
    'Codex detail:',
    '',
    String(item.detail ?? '').trim(),
    '',
    'Codex reasoning:',
    '',
    String(item.codexReasoning ?? '').trim(),
    '',
    excerptBlock(item, root),
    '',
  ].join('\n');
}

function needed(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, force: { type: 'boolean' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => neededLocked(values, n, root, ctx));
}

const isFableRound = (round) => round.fableRequired === true && round.baseOnly !== true;
const FABLE_DIFF = 'fable-diff.patch';

// The diff a Fable pass reviews, written next to its input and pinned by digest. The first proven Fable pass of a PR sees
// the WHOLE PR (fork point..this round's head): a PR that only became medium in a later round must not have its first
// rounds go unreviewed by Fable. After that, each round's own slice (what Codex saw), like Codex.
function writeFableDiff(state, round, root) {
  const earlierProven = state.rounds.some((r) => r.n < round.n && isFableRound(r) && r.arbiter?.proofOk === true);
  const scope = earlierProven ? 'round' : 'whole-pr';
  const from = scope === 'round' ? round.reviewBase ?? round.fromHead : round.forkPoint ?? state.rounds[0]?.reviewBase;
  if (typeof from !== 'string' || from === '' || typeof round.toHead !== 'string') {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'no-range', message: `round ${round.n} records no reviewed range: run codex-review for it again` });
  }
  const { patch, skipped } = reviewPatch(from, round.toHead, { cwd: root });
  const note = largeBinaryNote(skipped);
  const text = note.length === 0 ? patch : `${patch}\nLarge binary files (content not shown):\n${note.join('\n')}\n`;
  const diffPath = path.join(ensureRoundDir(root, round.n), FABLE_DIFF);
  writeFileAtomic(diffPath, text);
  return { diffPath, diffDigest: sha256(text), scope, from };
}

// The instructions part of a Fable review input. Everything a model wrote earlier (titles, reasons) is flattened to one line.
function reviewSection(state, round, diff) {
  const prior = state.rounds.filter((r) => r.n < round.n).flatMap((r) => r.items ?? []).filter((i) => i.final);
  const reasons = Array.isArray(round.fableReasons) && round.fableReasons.length > 0 ? round.fableReasons.map(oneLine).join('; ') : 'review lane';
  const out = [
    `# Fable review, round ${round.n}`,
    '',
    'Mode: REVIEW. Rule on every item listed below (none is fine) AND review the diff yourself as the second reviewer.',
    `Why Fable reviews this PR: ${reasons}. Risk level: ${oneLine(state.risk ?? 'unknown')}.`,
    `Diff to review (${diff.scope === 'whole-pr' ? 'the whole pull request' : `only what changed in round ${round.n}`}): ${diff.diffPath}`,
    `Diff sha256: ${diff.diffDigest}`,
    `Range: ${diff.from}..${round.toHead}`,
  ];
  const sensitive = Array.isArray(round.sensitivePaths) ? round.sensitivePaths.map(oneLine).filter(Boolean) : [];
  if (sensitive.length > 0) {
    out.push('', 'Sensitive files (attack them: find the input, role, race or ordering that breaks them):', ...sensitive.slice(0, 30).map((p) => `- ${p}`));
  }
  if (prior.length > 0) {
    out.push('', 'Already ruled in earlier rounds (do not raise again unless the cited code changed):');
    for (const i of prior.slice(-40)) out.push(`- ${oneLine(i.id)}: ${oneLine(i.title).slice(0, 120)} (${oneLine(i.final.decision ?? 'unknown')})`);
  }
  return out.join('\n');
}

function neededLocked(values, n, root, ctx) {
  let state = requireState(root);
  let round = findRound(state, n);
  const review = isFableRound(round);
  const mode = review ? 'review' : 'dispute';

  if (review && round.arbiter?.proofOk === true) return { exitCode: EXIT.OK, output: { needed: false, items: [], mode, done: true } };
  if (review && round.arbiter) {
    // An earlier pass for this round was not proven, so its rulings never counted (they only parked items): clear them and
    // rule again. The owner's own rulings stay.
    const reset = round.items.map((item) => {
      if (item.final?.by !== 'arbiter' || isOwnerRuled(item)) return item;
      const { final, arbiter, ...rest } = item;
      return rest;
    });
    state = updateItems(state, n, reset);
    round = findRound(state, n);
  }

  const force = review || values.force === true || forceArbiter(ctx.env);
  const items = round.items.filter((item) => arbiterNeeded(item, { lightLane: state.lightLane, force }));
  if (!review && items.length === 0) return { exitCode: EXIT.OK, output: { needed: false, items: [], mode } };

  const diff = review ? writeFableDiff(state, round, root) : null;
  const itemsPart = items.length > 0
    ? [`# Items to rule on (${items.length})`, '', ...items.map((item) => itemSection(item, root))]
    : ['# Items to rule on (0)', '', '_Codex raised nothing left to rule on in this round: your own review is the whole job._', ''];
  const body = [...(review ? [reviewSection(state, round, diff), ''] : []), ...itemsPart].join('\n');
  const digest = sha256(body);
  const digest8 = digest.slice(0, 8);
  const tag = `pipeline-arbiter R${n} ${digest8}`;
  const inputPath = path.join(ensureRoundDir(root, n), 'arbiter-input.md');
  writeFileAtomic(inputPath, `ROUND: ${n}\nINPUT-DIGEST: ${digest}\n\n${body}`);
  const ids = items.map((i) => i.id);
  const stored = { inputDigest: digest, items: ids, tag, mode, ...(diff ? { diffPath: diff.diffPath, diffDigest: diff.diffDigest, scope: diff.scope } : {}) };
  saveState(root, patchRound(state, n, { arbiter: stored }));
  const promptHeader = `ROUND: ${n}\nINPUT-DIGEST: ${digest}`;
  return {
    exitCode: EXIT.OK,
    output: { needed: true, mode, items: ids, inputPath, digest, digest8, tag, promptHeader, ...(diff ? { diffPath: diff.diffPath, scope: diff.scope } : {}) },
  };
}

// ---- apply ----------------------------------------------------------------------------------

const INPUT_RE = /^ROUND: (\d+)\nINPUT-DIGEST: ([0-9a-f]{64})\n\n([\s\S]*)$/;

// Does the file on disk still hold the input the arbiter was given? Errors are returned, not thrown: they fail the proof.
function checkInputFile(file, n, digest) {
  let text;
  try {
    text = readFileOrFail(file, 'arbiter input');
  } catch (err) {
    if (err instanceof Fail) return [`arbiter-input.md is missing or unreadable: ${err.output.message}`];
    throw err;
  }
  const m = INPUT_RE.exec(text);
  if (!m) return ['arbiter-input.md has no ROUND / INPUT-DIGEST header'];
  const errors = [];
  if (Number(m[1]) !== n) errors.push(`arbiter-input.md is for round ${m[1]}, not ${n}`);
  if (m[2] !== digest) errors.push('arbiter-input.md header digest differs from the one stored by `arbiter needed`');
  if (sha256(m[3]) !== digest) errors.push('arbiter-input.md body no longer matches the stored digest (edited since `arbiter needed`)');
  return errors;
}

function checkDiffFile(stored) {
  if (typeof stored.diffPath !== 'string' || typeof stored.diffDigest !== 'string') return ['the review input names no diff: run `arbiter needed` again'];
  let text;
  try {
    text = readFileOrFail(stored.diffPath, 'Fable review diff');
  } catch (err) {
    if (err instanceof Fail) return [`${FABLE_DIFF} is missing or unreadable: ${err.output.message}`];
    throw err;
  }
  return sha256(text) === stored.diffDigest ? [] : [`${FABLE_DIFF} no longer matches the digest Fable was given (edited since \`arbiter needed\`)`];
}

// The cache fingerprint of a Fable finding, computed like Codex's (codex.mjs#assignIds): the code around it at the
// round's head, so the same finding raised again is recognised.
function fingerprintAt(head, contentHash, root) {
  return (f) => {
    let content = null;
    if (f.file) {
      try {
        content = showFile(head, f.file, { cwd: root });
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
      }
    }
    const excerpt = content === null ? '' : excerptWindow(content, f.line)?.lines.join('\n') ?? '';
    return fingerprint({ file: f.file, title: f.title, excerpt, contentHash });
  };
}

function apply(rest, ctx) {
  const { values } = parseCommandArgs(rest, {
    round: { type: 'string' }, tag: { type: 'string' }, 'agent-id': { type: 'string' },
    'expect-model': { type: 'string' }, 'expect-effort': { type: 'string' },
    'projects-dir': { type: 'string' }, 'max-age-ms': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const agentId = nonEmpty(values, 'agent-id');
  const givenTag = nonEmpty(values, 'tag');
  if (agentId !== undefined && givenTag !== undefined) throw new UsageError('give at most one of --tag or --agent-id');
  const asked = { model: nonEmpty(values, 'expect-model'), effort: nonEmpty(values, 'expect-effort') };
  const env = ctx.env ?? process.env;
  // The expectation is the whole point of the proof: a flag (or an env var) that could change it would let a ruling
  // from any model count. Only the test suite (PIPELINE_TEST_MODE=1) may; otherwise the flags are ignored.
  const expectModelPrefix = (testMode(env) ? asked.model : undefined) ?? DEFAULT_EXPECT_MODEL;
  const expectEffort = (testMode(env) ? asked.effort : undefined) ?? DEFAULT_EXPECT_EFFORT;
  const maxAgeMs = intOption(values, 'max-age-ms', { min: 0 });
  const projectsDir = nonEmpty(values, 'projects-dir');

  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => applyLocked({
    n, agentId, givenTag, expectModelPrefix, expectEffort, maxAgeMs, projectsDir, env, root,
    ignoredExpectations: !testMode(env) && (asked.model !== undefined || asked.effort !== undefined),
  }));
}

function applyLocked({ n, agentId, givenTag, expectModelPrefix, expectEffort, maxAgeMs, projectsDir, env, root, ignoredExpectations }) {
  const state = requireState(root);
  const round = findRound(state, n);
  const stored = round.arbiter;
  if (!stored || !Array.isArray(stored.items) || typeof stored.inputDigest !== 'string') {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'no-arbiter-input', message: `round ${n} has no arbiter input: run \`arbiter needed\` first` });
  }
  const tag = givenTag ?? stored.tag;

  const found = findSubagentTranscript({ agentId, tag: agentId === undefined ? tag : undefined, projectsDir, maxAgeMs });
  if (!found) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'not-found',
      message: agentId !== undefined ? `no subagent transcript for agent id ${agentId}` : `no recent subagent transcript tagged ${JSON.stringify(tag)}`,
    });
  }
  const jsonlText = readFileOrFail(found.jsonlPath, 'transcript');
  const metaText = found.metaPath === null ? undefined : readFileOrFail(found.metaPath, 'meta');
  // The arbiter is invoked without a per-call model, so ANY override in the meta is an error. That holds even when
  // PIPELINE_ARBITER_MODEL_OVERRIDE is set: that switch only lets the proof-6 test start an agent on a bad model, and
  // the proof must fail for it (the ruling goes to a human), never be relaxed to accept it.
  const proof = proveModel({ jsonlText, metaText, expectModelPrefix, expectEffort, expectMetaModel: null, expectAgentType: 'arbiter' });

  const errors = [...proof.errors];
  const asksRound = new RegExp(`^ROUND: ${n}[ \\t]*$`, 'm');
  const asksDigest = new RegExp(`^INPUT-DIGEST: ${stored.inputDigest}[ \\t]*$`, 'm');
  if (!asksRound.test(proof.firstUserText)) errors.push(`the arbiter's prompt does not carry ROUND: ${n}`);
  if (!asksDigest.test(proof.firstUserText)) errors.push("the arbiter's prompt does not carry the stored INPUT-DIGEST");
  errors.push(...checkInputFile(path.join(roundDir(root, n), 'arbiter-input.md'), n, stored.inputDigest));
  // A review mode input names the diff Fable read by its digest; the file must still be exactly that diff.
  const review = stored.mode === 'review';
  if (review) errors.push(...checkDiffFile(stored));

  let rulings = null;
  try {
    const json = extractJsonBlock(proof.finalAssistantText);
    const checked = validateRulings(json, stored.items, { review });
    if (checked.ok) rulings = json;
    else errors.push(...checked.errors.map((e) => `rulings: ${e}`));
  } catch {
    errors.push('rulings: no JSON found in the arbiter\'s final message');
  }

  const proofOk = errors.length === 0 && rulings !== null;
  // Unproven: every arbitrated item gets a placeholder so applyRulings routes it to a human.
  const applied = proofOk
    ? rulings
    : { rulings: stored.items.map((id) => ({ id, ruling: null, confidence: 'low', reasoning: 'unverified' })) };
  const ruled = applyRulings(round.items, applied, { proofOk, transcript: found.jsonlPath });
  // Fable's own findings count only when proven; an unproven answer adds nothing (the round stays Fable-pending).
  const findingItems = proofOk && review
    ? fableFindingItems(rulings.findings, n, { transcript: found.jsonlPath, fingerprintFor: fingerprintAt(round.toHead, state.currentContentHash, root) })
    : [];
  const items = [...finalizeWithoutArbiter(ruled, { lightLane: state.lightLane, force: forceArbiter(env) }), ...findingItems];

  const dir = ensureRoundDir(root, n);
  writeJson(path.join(dir, 'rulings.json'), {
    proofOk,
    rulings: applied.rulings,
    ...(review && proofOk ? { findings: rulings.findings } : {}),
    ...(!proofOk && rulings ? { unverified: rulings.rulings, ...(review ? { unverifiedFindings: rulings.findings } : {}) } : {}),
  });
  writeJson(path.join(dir, 'model-proof.json'), {
    ok: proofOk, transcript: found.jsonlPath, models: proof.models, efforts: proof.efforts, stopReasonMissing: proof.stopReasonMissing, finalVia: proof.finalVia, errors, tag, round: n,
  });
  // The proof summary rides in the round, so the triage comment (which embeds the state) carries it to another machine.
  const efforts = proof.efforts && typeof proof.efforts === 'object' ? Object.keys(proof.efforts).join(', ') : '';
  const modelProof = proofOk ? { transcript: found.jsonlPath, models: proof.models, ...(efforts ? { effort: efforts } : {}) } : undefined;
  saveState(root, patchRound(updateItems(state, n, items), n, { arbiter: { ...stored, proofOk, transcript: found.jsonlPath }, modelProof }));

  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    exitCode: proofOk ? EXIT.OK : EXIT.FAILED,
    output: {
      ok: proofOk,
      round: n,
      tag,
      transcript: found.jsonlPath,
      stopReasonMissing: proof.stopReasonMissing,
      finalVia: proof.finalVia,
      errors,
      ...(ignoredExpectations ? { note: '--expect-model / --expect-effort ignored: the proof is pinned to claude-fable- at effort high' } : {}),
      items: stored.items.map((id) => ({
        id, ruling: byId.get(id)?.final?.decision ?? null, needsHuman: byId.get(id)?.final?.needsHuman ?? null,
      })),
      ...(review ? { mode: 'review', findings: findingItems.map((i) => ({ id: i.id, bucket: i.bucket, ruling: i.final.decision, needsHuman: i.final.needsHuman })) } : {}),
    },
  };
}

const SUBCOMMANDS = { needed, apply };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline arbiter ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
