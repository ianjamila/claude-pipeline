// The proof that a Claude substitute really ran, shared by `substitute apply` (a first review) and `triage second-review --apply` (a second review): the arbiter's
// model proof (lib/transcript.mjs#proveModel: pinned model on every turn, effort, agent type, no per-call model, one prompt, a complete final answer), exactly ONE
// transcript under the tag, the first prompt EXACTLY the prepared one, only Read / Grep / Glob used, and every file the agent was told to read really read.
// What the answer must look like (findings, or second-review verdicts) is the caller's to judge from `proof.finalAssistantText`.
import { findSubagentTranscript, findTaggedTranscripts, proveModel, toolCallsOf } from './transcript.mjs';
import { readFileOrFail } from './review-context.mjs';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
// The hand-back tool is how a background subagent delivers its report (transcript.mjs); it is not a way to act on the repository.
export const ALLOWED_TOOLS = [...READ_ONLY_TOOLS, 'SubagentHandback'];
export const MODEL_PREFIX = { 'substitute-opus': 'claude-opus-', 'substitute-fable': 'claude-fable-' };
export const PROOF_EFFORT = 'high';

// -> null when no recent transcript carries the tag; else { found, proof, claudeCodeVersions, jsonlText }. Every problem is pushed to `errors` (the caller's list).
//   agent: the agent type the attempt was prepared for; expectedPrompt: the exact first prompt; requiredReads: absolute paths that must each show a successful Read.
export function proveSubstituteRun({ tag, projectsDir, maxAgeMs, agent, expectedPrompt, requiredReads, errors }) {
  const found = findSubagentTranscript({ tag, projectsDir, maxAgeMs });
  if (!found) return null;
  const jsonlText = readFileOrFail(found.jsonlPath, 'transcript');
  const metaText = found.metaPath === null ? undefined : readFileOrFail(found.metaPath, 'meta');

  const tagged = findTaggedTranscripts({ tag, projectsDir });
  if (tagged.length !== 1) errors.push(`rerolled: ${tagged.length} transcripts carry the tag ${JSON.stringify(tag)}; a tag is one run`);

  // The arbiter's proof: pinned model per turn, effort, agent type, no per-call model, one prompt, a complete final answer.
  const proof = proveModel({ jsonlText, metaText, expectModelPrefix: MODEL_PREFIX[agent] ?? '', expectEffort: PROOF_EFFORT, expectMetaModel: null, expectAgentType: agent });
  errors.push(...proof.errors);
  // Trailing whitespace is not text; everything else must be equal, so nothing can be added in front of or after the fixed prompt.
  if (proof.firstUserText.trimEnd() !== expectedPrompt.trimEnd()) errors.push('the agent\'s first prompt is not exactly the prepared one (promptHeader + the fixed Read line): text was added or changed');

  // Only Read / Grep / Glob were used, and every file of the packet was really read.
  const calls = toolCallsOf(jsonlText);
  for (const name of new Set(calls.map((c) => c.name))) if (!ALLOWED_TOOLS.includes(name)) errors.push(`tool ${name} was used; only ${READ_ONLY_TOOLS.join(', ')} are allowed`);
  for (const file of requiredReads) {
    if (!calls.some((c) => c.name === 'Read' && c.input.file_path === file && c.answered && !c.isError)) errors.push(`the transcript shows no successful Read of ${file}`);
  }
  return { found, proof, claudeCodeVersions: proof.claudeCodeVersions ?? [], jsonlText };
}
