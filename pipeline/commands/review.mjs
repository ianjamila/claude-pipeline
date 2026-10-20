// `pipeline review header | add`: the reviewer obligations of a review round (lib/obligations.mjs). `codex-review` records
// which extra reviewers a round owes (security, the optional Fable final pass); `header` prints the two prompt lines that bind
// a reviewer's answer to one input, and `add` PROVES from Claude Code's own transcript that the right model answered that
// input before its findings count. An unproven answer marks the obligation failed (a human looks), never met.
import { readFileSync } from 'node:fs';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { assignIds, validateFindings } from '../lib/codex.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { GitError, showFile } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { OBLIGATION_SOURCES, obligationDigest, promptHeader } from '../lib/obligations.mjs';
import { loadState, saveState, updateItems } from '../lib/state.mjs';
import { extractJsonBlock, findSubagentTranscript, proveModel } from '../lib/transcript.mjs';
import { excerptWindow, findRound, patchRound, requireState, withReviewLock } from '../lib/review-context.mjs';

export const meta = {
  summary: 'reviewer obligations of a review round: the prompt header, and proving + adding a reviewer\'s findings',
  usage: [
    'pipeline review header --pr N --round R --source security|fable --base SHA --head SHA [--repo DIR]',
    '  -> {ok, promptHeader, digest}; paste promptHeader verbatim as the first two lines of the reviewer\'s prompt (`codex-review` also prints it per owed reviewer)',
    'pipeline review add --round R --source security|fable --tag TAG [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  -> {ok, round, source, added:[ids], errors}; proves the model (security: claude-sonnet- at effort high; fable: claude-fable- at effort high) and the header,',
    '     then adds the findings as items R<n>-X<B|S|W><i> (security) / R<n>-F<B|S|W><i> (fable) and marks the obligation met;',
    '     exit 1 {error: no-obligation | already-met} or an unproven answer (obligation failed, a human looks; add may be run again), 2 no transcript',
  ].join('\n'),
};

const SOURCE_FACTS = {
  security: { prefix: 'claude-sonnet-', agentType: 'security-reviewer', letter: 'X' },
  fable: { prefix: 'claude-fable-', agentType: 'fable-reviewer', letter: 'F' },
};
// Both reviewers pin effort high in their agent files, so both are proven at high through the normal proveModel path.

function sourceOption(values) {
  const source = requireOption(values, 'source');
  if (!OBLIGATION_SOURCES.includes(source)) throw new UsageError(`--source must be ${OBLIGATION_SOURCES.join(' or ')}`);
  return source;
}

function readOrFail(file, what) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'read', message: `cannot read ${what} ${file}: ${err.code ?? err.message}` });
  }
}

async function header(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, round: { type: 'string' }, source: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const source = sourceOption(values);
  const base = requireOption(values, 'base');
  const head = requireOption(values, 'head');
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
  // The digest names the repo as the review state does (set from the GitHub slug when round 1 was recorded).
  const repo = state && state.pr === pr && typeof state.repo === 'string'
    ? state.repo
    : await guardGh(() => createGitHub({ cwd: root, env: ctx.env }).repo().slug); // a GitHub failure is exit 3
  const digest = obligationDigest({ repo, pr, source, base, head });
  return { exitCode: EXIT.OK, output: { ok: true, source, round, promptHeader: promptHeader(round, digest), digest } };
}

async function add(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    round: { type: 'string' }, source: { type: 'string' }, tag: { type: 'string' }, 'projects-dir': { type: 'string' }, 'max-age-ms': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const source = sourceOption(values);
  const tag = requireOption(values, 'tag');
  const maxAgeMs = intOption(values, 'max-age-ms', { min: 1 });
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  const facts = SOURCE_FACTS[source];
  const first = requireState(root);

  return withReviewLock(root, first.pr, ctx, () => {
    const state = requireState(root);
    const round = findRound(state, n);
    const obligation = (round.obligations ?? []).find((o) => o.source === source);
    if (!obligation) {
      throw new Fail(EXIT.FAILED, { ok: false, error: 'no-obligation', message: `round ${n} owes no ${source} review` });
    }
    if (obligation.status === 'met') {
      throw new Fail(EXIT.FAILED, { ok: false, error: 'already-met', message: `the ${source} obligation of round ${n} is already met` });
    }
    const found = findSubagentTranscript({ tag, projectsDir: values['projects-dir'], ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) });
    if (!found) throw new Fail(EXIT.USAGE, { ok: false, error: 'not-found', message: `no recent subagent transcript tagged ${JSON.stringify(tag)}` });
    const jsonlText = readOrFail(found.jsonlPath, 'transcript');
    const metaText = found.metaPath === null ? undefined : readOrFail(found.metaPath, 'meta');

    const proof = proveModel({
      jsonlText, metaText, expectModelPrefix: facts.prefix, expectEffort: 'high', expectMetaModel: null, expectAgentType: facts.agentType,
    });
    const errors = [...proof.errors];
    const prompt = proof.firstUserText ?? '';
    if (!new RegExp(`^ROUND: ${n}[ \\t]*$`, 'm').test(prompt)) errors.push(`the reviewer's prompt does not carry ROUND: ${n}`);
    if (!new RegExp(`^INPUT-DIGEST: ${obligation.digest}[ \\t]*$`, 'm').test(prompt)) errors.push("the reviewer's prompt does not carry this round's INPUT-DIGEST");

    let json = null;
    try {
      json = extractJsonBlock(proof.finalAssistantText);
      const checked = validateFindings(json);
      if (!checked.ok) { errors.push(...checked.errors.map((e) => `findings: ${e}`)); json = null; }
    } catch {
      errors.push("findings: no JSON found in the reviewer's final message");
    }

    if (errors.length > 0 || json === null) {
      const failed = (round.obligations ?? []).map((o) => (o.source === source ? { ...o, status: 'failed', reason: errors.join('; ').slice(0, 300), tag } : o));
      saveState(root, patchRound(state, n, { obligations: failed }));
      throw new Fail(EXIT.FAILED, { ok: false, round: n, source, added: [], errors });
    }

    const cache = new Map();
    const excerptFor = (file, line) => {
      if (!file) return '';
      if (!cache.has(file)) {
        let text = null;
        try { text = showFile(round.toHead, file, { cwd: root }); } catch (err) { if (!(err instanceof GitError)) throw err; }
        cache.set(file, text);
      }
      return excerptWindow(cache.get(file), line)?.lines.join('\n') ?? '';
    };
    // Same item shape as a Codex finding, with the source letter in the id so a reviewer's items never collide with Codex's.
    const items = assignIds(json, n, excerptFor, { contentHash: round.contentHashAtToHead })
      .map((item) => ({ ...item, id: item.id.replace(`R${n}-`, `R${n}-${facts.letter}`), source }));
    const met = (round.obligations ?? []).map((o) => {
      if (o.source !== source) return o;
      const { reason: _reason, ...rest } = o;
      return { ...rest, status: 'met', tag };
    });
    saveState(root, patchRound(updateItems(state, n, items), n, { obligations: met }));
    return { exitCode: EXIT.OK, output: { ok: true, round: n, source, added: items.map((i) => i.id), errors: [] } };
  });
}

const SUBCOMMANDS = { header, add };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline review ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
