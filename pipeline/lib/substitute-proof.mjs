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
// What one Read call returns: at most READ_PAGE_LINES lines (the agent's Read default is offset 1, limit 2000), and fewer when the page would pass Read's size cap of about 25,000
// tokens a call: Read then stops early and answers normally (no error), so the agent must go on from the last line shown. A longer file is read in several calls; the proof below
// credits only the lines each call RETURNED, and only while the returned text equals the file's line (lib/transcript.mjs#readReturnedRows), and needs them to cover every line. A long
// line is returned whole (it only costs tokens), unless one line alone is more than a Read call is budgeted at (unreadablePacket).
export const READ_PAGE_LINES = 2000;
// The tokens one Read call is budgeted at when estimating how many calls a packet needs: well below the 25,000-token cap, so a packet the estimate admits is not one that
// needs more calls than counted. A text's tokens are estimated at one per 3 characters (code, JSON and diffs run 2.5 to 4 characters a token) plus 2 for each line's number.
export const READ_TOKENS_PER_CALL = 20000;
export const CHARS_PER_TOKEN = 3;
export const LINE_NUMBER_TOKENS = 2;
// The most Read calls a packet may need, input file and exported files together. The call-budget hook stops a reviewer-type subagent at 40 tool calls (its tightest
// stop line; other agents 90), and the agent also needs calls for Grep / Read of the repository around the diff: 15 calls leaves it 25 of the 40. `substitute prepare` and
// `triage second-review` refuse a packet over this (packet-unreadable) instead of letting the agent burn its attempts on one it cannot finish.
export const MAX_READ_PAGES = 15;
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

// The tokens a Read of this text shows, estimated: its characters over CHARS_PER_TOKEN, and a number per line.
export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN) + lineCountOf(text) * LINE_NUMBER_TOKENS;

// Files Read does not return as numbered text lines: notebooks, images and PDFs it renders instead (an svg is text and is read as such), and anything binary (a NUL byte).
const NOT_TEXT_EXT = /\.(ipynb|png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif|pdf)$/i;
const notTextReason = (f) => (NOT_TEXT_EXT.test(f.rel) ? 'a notebook, image or PDF, which Read does not return as numbered lines' : f.content.includes('\u0000') ? 'binary (it holds a NUL byte), which Read does not return as numbered lines' : null);

// Could a substitute agent read all of these files in full? files: [{rel, content}] (the input file and every exported file). -> null when it can, else
// { message, ...extra fields } for the refusal's output:
//   a file Read cannot return as numbered text (notBinary: notTextReason): { unreadableFile: {rel, reason} };
//   a single line whose estimated tokens pass READ_TOKENS_PER_CALL (no Read call can hold it): { longLine: {rel, line, tokens} };
//   else a file needs max(ceil(lines / READ_PAGE_LINES), ceil(estimateTokens / READ_TOKENS_PER_CALL)) Read calls (an empty file 1), and the files together may not need more than
//   MAX_READ_PAGES: { pages, maxPages, files: [{rel, lines, tokens, pages}] }.
export function unreadablePacket(files) {
  for (const f of files) {
    const reason = notTextReason(f);
    if (reason !== null) {
      return { message: `the evidence for a substitute holds a file the agent cannot read in full: ${f.rel} is ${reason}: not eligible; park the round as without a substitute`, unreadableFile: { rel: f.rel, reason } };
    }
  }
  for (const f of files) {
    const rows = f.content.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const tokens = Math.ceil(rows[i].length / CHARS_PER_TOKEN) + LINE_NUMBER_TOKENS;
      if (tokens > READ_TOKENS_PER_CALL) {
        return { message: `the evidence for a substitute holds a line the agent cannot read: ${f.rel} line ${i + 1} is about ${tokens} tokens, more than the ${READ_TOKENS_PER_CALL} one Read call is budgeted at (the cap of one call is about 25,000): not eligible; park the round as without a substitute`, longLine: { rel: f.rel, line: i + 1, tokens } };
      }
    }
  }
  const rows = files.map((f) => {
    const lines = lineCountOf(f.content);
    const tokens = estimateTokens(f.content);
    return { rel: f.rel, lines, tokens, pages: Math.max(1, Math.ceil(lines / READ_PAGE_LINES), Math.ceil(tokens / READ_TOKENS_PER_CALL)) };
  });
  const pages = rows.reduce((n, r) => n + r.pages, 0);
  if (pages <= MAX_READ_PAGES) return null;
  return {
    message: `the evidence for a substitute cannot be read in full by the agent: the files need an estimated ${pages} Read calls (${rows.map((r) => `${r.rel}: ${r.lines} lines, about ${r.tokens} tokens`).join(', ')}; a call returns at most ${READ_PAGE_LINES} lines or about ${READ_TOKENS_PER_CALL} tokens), over the ${MAX_READ_PAGES} the agent can spend: not eligible; park the round as without a substitute`,
    pages, maxPages: MAX_READ_PAGES, files: rows,
  };
}

// The line numbers a Read credits when its returned rows (call.rows) are held against the file's text: a row counts only when its text equals the file's line n (a trailing \r
// ignored on both sides), and the range ends before the first row that differs (a row cut short is not credited, nor is anything after it). -> { first, last } or null.
export function creditedRange(rows, fileText) {
  if (!Array.isArray(rows) || rows.length === 0 || typeof fileText !== 'string') return null;
  const fileLines = fileText.split('\n');
  const total = lineCountOf(fileText);
  const same = (a, b) => a.replace(/\r$/, '') === b.replace(/\r$/, '');
  let last = null;
  for (const row of rows) {
    if (!Number.isInteger(row.n) || row.n < 1 || row.n > total || !same(row.text, fileLines[row.n - 1])) break;
    last = row.n;
  }
  return last === null ? null : { first: rows[0].n, last };
}

// Do the successful Reads of `file` in `calls` (toolCallsOf) together cover all of its `lines` lines? Each Read covers the line numbers its RESULT showed (call.returned: Read
// stops early at a size cap and still answers normally, so the requested offset / limit prove nothing); a call whose numbers could not be parsed covers nothing. With `fileText` (the
// file's content) a row is credited only when its text equals the file's line (creditedRange: R10-F1); without it only the numbers are held (the unit tests of the ranges). The ranges may
// come in any order and overlap, but a gap leaves lines unread. A call with a malformed input (an offset that is not a whole number >= 0, a limit that is not a whole number
// >= 1) covers nothing; offset 0 is valid (Read returns from line 1). An empty file needs one successful Read. (cp #256 R8-B2: one Read naming the file used to be enough;
// R9-F1: so did a Read that stopped early.)
export function readsCoverFile(calls, file, lines, fileText) {
  const whole = (v, min) => Number.isInteger(v) && v >= min;
  const ok = calls.filter((c) => c.name === 'Read' && c.input?.file_path === file && c.answered && !c.isError
    && (c.input.offset === undefined || whole(c.input.offset, 0)) && (c.input.limit === undefined || whole(c.input.limit, 1)));
  if (lines === 0) return ok.length > 0;
  const ranges = ok.map((c) => (fileText === undefined ? c.returned : creditedRange(c.rows, fileText))).filter((r) => r && whole(r.first, 1) && whole(r.last, r.first)).map((r) => [r.first, r.last]);
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
    let fileText;
    try { fileText = readFileSync(file, 'utf8'); lines = lineCountOf(fileText); } catch { errors.push(`${file} cannot be read to check that the agent read all of it`); continue; }
    if (!readsCoverFile(calls, file, lines, fileText)) {
      errors.push(calls.some((c) => c.name === 'Read' && c.input?.file_path === file && c.answered && !c.isError)
        ? `the transcript's Reads of ${file} do not cover all of its ${lines} lines (every line must be read, in order, and each returned line must be the file's own text: a Read stops at ${READ_PAGE_LINES} lines or at its size cap of about 25,000 tokens, whichever comes first, so go on from the last line shown)`
        : `the transcript shows no successful Read of ${file}`);
    }
  }
  return { found, proof, claudeCodeVersions: proof.claudeCodeVersions ?? [], jsonlText };
}
