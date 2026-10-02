// Proves, from Claude Code's own transcript log, that a subagent (the arbiter) really ran on the pinned model at the
// pinned effort: never the agent's say-so. Finds the transcript by tag (the Agent description the ship skill set) or
// by agent id, then checks every assistant turn. Exit 0 = proven, 1 = proof failed, 2 = no transcript or unreadable
// (an environment problem the caller may retry, which is why it is not folded into "failed").
import { readFileSync } from 'node:fs';
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded } from '../lib/cmd-common.mjs';
import { findSubagentTranscript, proveModel } from '../lib/transcript.mjs';

export const meta = {
  summary: 'prove a subagent ran on the expected model and effort',
  usage: [
    'pipeline model-proof (--tag TAG | --agent-id ID) [--expect-model claude-fable-] [--expect-effort high]',
    '                     [--expect-agent-type TYPE] [--expect-meta-model MODEL] [--projects-dir DIR] [--max-age-ms N]',
    '  -> {ok, transcript, meta, models, efforts, errors, finalAssistantText}; exit 0 proven, 1 mismatch, 2 not found/unreadable',
  ].join('\n'),
};

export const DEFAULT_EXPECT_MODEL = 'claude-fable-';
export const DEFAULT_EXPECT_EFFORT = 'high';

// An empty expectation would "prove" anything; reject it as a usage error rather than let it through.
function nonEmpty(values, name) {
  if (values[name] === '') throw new UsageError(`--${name} must not be empty`);
  return values[name];
}

function readOrFail(file, what) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'read', message: `cannot read ${what} ${file}: ${err.code ?? err.message}` });
  }
}

export const run = guarded(async (argv) => {
  const { values } = parseCommandArgs(argv, {
    tag: { type: 'string' },
    'agent-id': { type: 'string' },
    'expect-model': { type: 'string' },
    'expect-effort': { type: 'string' },
    'expect-agent-type': { type: 'string' },
    'expect-meta-model': { type: 'string' },
    'projects-dir': { type: 'string' },
    'max-age-ms': { type: 'string' },
  }, { allowPositionals: false });

  const tag = nonEmpty(values, 'tag');
  const agentId = nonEmpty(values, 'agent-id');
  if ((tag === undefined) === (agentId === undefined)) throw new UsageError('give exactly one of --tag or --agent-id');
  const expectModelPrefix = nonEmpty(values, 'expect-model') ?? DEFAULT_EXPECT_MODEL;
  const expectEffort = nonEmpty(values, 'expect-effort') ?? DEFAULT_EXPECT_EFFORT;
  const expectAgentType = nonEmpty(values, 'expect-agent-type') ?? null;
  const expectMetaModel = nonEmpty(values, 'expect-meta-model') ?? null;
  const projectsDir = nonEmpty(values, 'projects-dir');
  const maxAgeMs = intOption(values, 'max-age-ms', { min: 0 });

  const found = findSubagentTranscript({ agentId, tag, projectsDir, maxAgeMs });
  if (!found) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'not-found',
      message: agentId !== undefined ? `no subagent transcript for agent id ${agentId}` : `no recent subagent transcript tagged ${JSON.stringify(tag)}`,
    });
  }

  const jsonlText = readOrFail(found.jsonlPath, 'transcript');
  // No meta file at all is a proof failure ("meta missing", exit 1), but one that exists and cannot be read is exit 2.
  const metaText = found.metaPath === null ? undefined : readOrFail(found.metaPath, 'meta');
  const proof = proveModel({ jsonlText, metaText, expectModelPrefix, expectEffort, expectMetaModel, expectAgentType });

  let metaObject = null;
  try { metaObject = metaText === undefined ? null : JSON.parse(metaText); } catch { /* proveModel already reported it */ }
  return {
    exitCode: proof.ok ? EXIT.OK : EXIT.FAILED,
    output: {
      ok: proof.ok,
      transcript: found.jsonlPath,
      meta: metaObject,
      models: proof.models,
      efforts: proof.efforts,
      errors: proof.errors,
      finalAssistantText: proof.finalAssistantText,
    },
  };
});
