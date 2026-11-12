// The proof that a Claude substitute really ran, shared by `substitute apply` (a first review) and `triage second-review --apply` (a second review): the arbiter's
// model proof (lib/transcript.mjs#proveModel: pinned model on every turn, effort, agent type, no per-call model, one prompt, a complete final answer), exactly ONE
// transcript under the tag, the first prompt EXACTLY the prepared one, only Read / Grep / Glob used, and every file the agent was told to read really read.
// What the answer must look like (findings, or second-review verdicts) is the caller's to judge from `proof.finalAssistantText`.
import { findSubagentTranscript, findTaggedTranscripts, proveModel, toolCallsOf } from './transcript.mjs';
import { readFileOrFail } from './review-context.mjs';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { accountProjectsRoot, transcriptUnderRoot } from './floor-proof.mjs';
import { seamFlag } from './proc.mjs';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
// The hand-back tool is how a background subagent delivers its report (transcript.mjs); it is not a way to act on the repository.
export const ALLOWED_TOOLS = [...READ_ONLY_TOOLS, 'SubagentHandback'];
export const MODEL_PREFIX = { 'substitute-opus': 'claude-opus-', 'substitute-fable': 'claude-fable-' };
export const PROOF_EFFORT = 'high';
// findSubagentTranscript refuses a non-finite age, so "any age" is a number of milliseconds longer than any file can be old.
const ANY_AGE_MS = Number.MAX_SAFE_INTEGER;

// `--projects-dir` and `--max-age-ms` let a caller point the proof at any folder and any age, which is only fair for the test suite: a substitute REPLACES a Codex review,
// so an agent that could name the folder could forge the transcript that proves it. Outside test mode (the checkout-only seam PIPELINE_TEST_MODE, ignored by an installed
// copy: lib/seams.mjs) either flag is a usage error, and the transcript is searched only under the account's own projects folder (proveSubstituteRun below).
export function refuseTestOnlyFlags(values, env) {
  if (seamFlag('PIPELINE_TEST_MODE', env)) return;
  for (const name of ['projects-dir', 'max-age-ms']) {
    if (values[name] !== undefined) {
      throw new Fail(EXIT.USAGE, { ok: false, error: 'test-only-flag', message: `--${name} is a test-only flag: a substitute review is proven only from a transcript under the account's own projects folder, found by its tag (drop --${name})` });
    }
  }
}

// -> null when no transcript carries the tag (one that does is judged whatever its age: the window applies only when none does); else { found, proof, claudeCodeVersions, jsonlText }. Every problem is pushed to `errors` (the caller's list).
//   agent: the agent type the attempt was prepared for; expectedPrompt: the exact first prompt; requiredReads: absolute paths that must each show a successful Read.
//   projectsDir / maxAgeMs: test mode only (refuseTestOnlyFlags); without projectsDir the search is under the account's projects folder and a found transcript must really be inside it.
export function proveSubstituteRun({ tag, projectsDir, maxAgeMs, agent, expectedPrompt, requiredReads, errors, env }) {
  const accountRoot = projectsDir === undefined ? accountProjectsRoot({ env }) : undefined;
  if (accountRoot !== undefined) projectsDir = accountRoot;
  // The tag binds a transcript to one attempt at one round content, so a transcript that carries it is THE run whatever its age: the re-roll count (findTaggedTranscripts below) has
  // no age limit either, and answering "not found" for an old one would send the caller to start a second agent that the next apply rejects as rerolled (cp #256 R3-F1). The
  // age window only keeps an unrelated old run from being picked when nothing carries the tag at all - and then it finds nothing either.
  const tagged = findTaggedTranscripts({ tag, projectsDir });
  const found = findSubagentTranscript({ tag, projectsDir, maxAgeMs: tagged.length > 0 ? ANY_AGE_MS : maxAgeMs });
  if (!found) return null;
  if (accountRoot !== undefined && !transcriptUnderRoot(found.jsonlPath, accountRoot)) errors.push("the transcript is not under the account's projects folder (a link out of it does not count)");
  const jsonlText = readFileOrFail(found.jsonlPath, 'transcript');
  const metaText = found.metaPath === null ? undefined : readFileOrFail(found.metaPath, 'meta');

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
