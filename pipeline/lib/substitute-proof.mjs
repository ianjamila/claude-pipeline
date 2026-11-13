// The proof that a Claude substitute really ran, shared by `substitute apply` (a first review) and `triage second-review --apply` (a second review): the arbiter's
// model proof (lib/transcript.mjs#proveModel: pinned model on every turn, effort, agent type, no per-call model, one prompt, a complete final answer), exactly ONE
// transcript under the tag, the first prompt EXACTLY the prepared one, only Read / Grep / Glob used, and every file the agent was told to read really read.
// What the answer must look like (findings, or second-review verdicts) is the caller's to judge from `proof.finalAssistantText`.
import { findSubagentTranscript, findTaggedTranscripts, proveModel, toolCallsOf } from './transcript.mjs';
import { readFileSync } from 'node:fs';
import { readFileOrFail } from './review-context.mjs';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { accountProjectsRoot, transcriptUnderRoot } from './floor-proof.mjs';
import { seamFlag } from './proc.mjs';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
// The hand-back tool is how a background subagent delivers its report (transcript.mjs); it is not a way to act on the repository.
export const ALLOWED_TOOLS = [...READ_ONLY_TOOLS, 'SubagentHandback'];
export const MODEL_PREFIX = { 'substitute-opus': 'claude-opus-', 'substitute-fable': 'claude-fable-' };
// A Read call returns at most this many lines unless it is given a limit; the agent's Read default is offset 1, limit 2000. A required file longer than one page is not
// accepted into a substitute packet at all (`substitute prepare`: packet-unreadable), so the agent is never asked for more than it can read in one go.
export const READ_PAGE_LINES = 2000;
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

// The lines of a text as Read numbers them: a final newline does not start another line, and an empty file has none.
export const lineCountOf = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// Do the successful Reads of `file` in `calls` (toolCallsOf) together cover all of its `lines` lines? Each Read covers offset .. offset + limit - 1 (default offset 1, limit
// READ_PAGE_LINES); the ranges may come in any order and overlap, but a gap leaves lines unread. An offset or limit that is not a whole number (>= 1 for a limit, >= 1 for an
// offset) covers nothing. An empty file needs one successful Read. (cp #256 R8-B2: one Read naming the file, even of a single line, used to be enough.)
export function readsCoverFile(calls, file, lines) {
  const whole = (v, min) => Number.isInteger(v) && v >= min;
  const ranges = [];
  for (const c of calls) {
    if (c.name !== 'Read' || c.input?.file_path !== file || !c.answered || c.isError) continue;
    const { offset, limit } = c.input;
    if (offset !== undefined && !whole(offset, 1)) continue;
    if (limit !== undefined && !whole(limit, 1)) continue;
    const start = offset ?? 1;
    ranges.push([start, start + (limit ?? READ_PAGE_LINES) - 1]);
  }
  if (ranges.length === 0) return false;
  ranges.sort((x, y) => x[0] - y[0]);
  let next = 1; // the first line not yet seen to be read
  for (const [from, to] of ranges) {
    if (from > next) break;
    next = Math.max(next, to + 1);
  }
  return next > lines;
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
    let lines;
    try { lines = lineCountOf(readFileSync(file, 'utf8')); } catch { errors.push(`${file} cannot be read to check that the agent read all of it`); continue; }
    if (!readsCoverFile(calls, file, lines)) {
      errors.push(calls.some((c) => c.name === 'Read' && c.input?.file_path === file && c.answered && !c.isError)
        ? `the transcript's Reads of ${file} do not cover all of its ${lines} lines (offset / limit: every line must be read; a Read without them returns the first ${READ_PAGE_LINES})`
        : `the transcript shows no successful Read of ${file}`);
    }
  }
  return { found, proof, claudeCodeVersions: proof.claudeCodeVersions ?? [], jsonlText };
}
