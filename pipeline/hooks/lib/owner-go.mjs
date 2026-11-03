// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which fires for the owner's typed prompts and for harness turns, which #128 screens out) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest> · repo <owner/name>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval).
// `P merge` then needs a record for exactly that repository, PR, head and owner-item set; the guard needs one (for that repository and
// PR, in that session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. Phase 3b: the repository
// is part of the request, so a "merge" said for #N of one repository never approves #N of another (a fork, a mirror, a vendored copy
// that shares the commit). A request line without it approves nothing. guard-files keeps
// agents from writing the folder or running the recorder.
// #128 (harness messages are not the owner's words): UserPromptSubmit also fires for background-task notices, other sessions' and
// subagents' messages, plugin and scheduled (/loop) turns and headless `claude -p` runs, and its input carries no field that says which.
// Two defences, both "record less": (1) the recorders skip a prompt that is evidently not typed (notOwnerWords: hook-input provenance, the
// transcript entry once it exists, a text envelope), and the ruling look-back skips turns the TRANSCRIPT METADATA marks synthetic
// (entrySource: never text); (2) at USE time, when the transcript has caught up, `P merge`, the guard and `P triage owner-ruling`
// accept a record only when its prompt entry (found by the hook's prompt_id, else by text and time) is the owner's (promptProvenance).
// A record whose entry cannot be found or is not the owner's approves nothing. Records written before #128 carry no prompt_id, so they
// are refused for their last day at most.
// Residual (#128): the model could still write a transcript entry itself (files-policy refuses a tool write to ~/.claude*/projects/**/*.jsonl)
// or type into an interactive `claude --resume` through a pty, which types as the owner; GitHub-side separation (issue #65) is the backstop.
// Residual (owner ruling 2026-10-14, the "cheap step"): the agent runs as the same OS user, so a program the guards cannot
// see into can still write the folder; the transcript the recorder reads is a file of that user; and the agent's GitHub
// token is the owner's. A second GitHub identity + a ruleset is the server-side backstop (issue #65).
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTranscriptFile } from '../../lib/paths.mjs';

export const OWNER_GO_REL = '.claude/pipeline-state/owner-go';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a "merge" older than a day approves nothing
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const PROVENANCE_CHUNK_BYTES = 4 * 1024 * 1024; // promptProvenance reads the transcript backwards in chunks this big …
const PROVENANCE_CAP_BYTES = 64 * 1024 * 1024; // … and gives up (missing) this far back
const FALLBACK_WINDOW_MS = 120 * 1000; // a record with no prompt_id is matched to a transcript entry by its text within this much time
const MAX_RECORD_BYTES = 1024 * 1024; // one session file; a bigger one is not read
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const HEAD_CHARS = 12; // the head is shown (and matched) by its first 12 characters at least

// The account's home from the OS user database, NOT $HOME: `HOME=/tmp/x P merge …` must not point the check at a folder the agent
// can write. (The `home` options below are for the unit tests, which call these functions in-process.)
export function accountHome() {
  try {
    const h = os.userInfo().homedir;
    if (typeof h === 'string' && h) return h;
  } catch { /* no passwd entry: fall back */ }
  return os.homedir();
}

export const ownerGoDir = (home = accountHome()) => path.join(home, ...OWNER_GO_REL.split('/'));

// The words that may follow "merge" in an approval besides its targets (#N, N, a head prefix).
const FILLER = /^(?:and|it|both|all|them|these|those|please|pls|now|go|ok|okay|thanks|thank|you|thx|ty)$/i;

// A prompt that approves: "merge", "merge #58", "merge 1318 1319", "Merge it.", "merge a1b2c3d4e5f6". Anything else is not an
// approval: "do not merge", "merge?", "merge later", "merge after CI", "why merge". Returns null or { prs, shas }.
export function parseApproval(prompt) {
  const t = String(prompt ?? '').trim();
  const m = /^merge(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes('?')) return null;
  const prs = [];
  const shas = [];
  for (const tok of rest.replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#?(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if (/^[0-9a-f]{7,40}$/i.test(tok)) shas.push(tok.toLowerCase());
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], shas: [...new Set(shas)] };
}

// The merge request a reply ENDS with. The reply's last lines are the request (skills/ship): optional `Head <sha12> · items <digest> · repo <owner/name>`
// lines (or, for several PRs, `#N head <sha12> · items <digest> · repo <owner/name>`) directly above the 🔀 line, which is the last non-blank line.
// Only that terminal block binds: an earlier block in the same reply, a Head line with prose between it and the 🔀 line, or any
// text after the 🔀 line binds nothing, and a PR bound twice (two heads, or the same line twice) is ambiguous, so it binds nothing.
// Returns { prs: [N…] (every PR on the 🔀 line; [] when the reply does not end with it), requests: [{ pr, head, items, repo }] } (repo: the
// lower-cased owner/name, or null when the line names none: such a request approves nothing).
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
const REPO_NAME = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)(?:\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME}))?\\s*$`, 'i');
export function presentedRequests(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const r = READY_LINE.exec(lines[lines.length - 1] ?? '');
  if (!r) return { prs: [], requests: [] };
  const prs = [...new Set([...r[1].split(/—|\s--?\s|\bsay\b/)[0].matchAll(/#(\d{1,6})\b/g)].map((x) => Number(x[1])))];
  const block = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const h = HEAD_LINE.exec(lines[i]);
    if (!h) break;
    block.unshift(h);
  }
  const bound = new Map();
  for (const h of block) {
    const pr = h[1] ? Number(h[1]) : prs.length === 1 ? prs[0] : null;
    if (pr === null || !prs.includes(pr)) continue;
    bound.set(pr, bound.has(pr) ? null : { pr, head: h[2].toLowerCase(), items: h[3].toLowerCase(), repo: h[4] ? h[4].toLowerCase() : null });
  }
  return { prs, requests: [...bound.values()].filter(Boolean) };
}

// Phase 3b: an owner ruling in chat (`P triage owner-ruling`) was the agent's word too: --owner-quote could be any text. A reply that
// asks the owner to rule ENDS with `⚖️ Owner ruling needed #N: R1-B1, R2-S3 · content <digest12> · repo owner/name` (`P triage ruling-request`
// writes it; skills/ship reference/review-loop.md), and the owner's next prompt is recorded with those ids; owner-ruling then needs a
// recorded prompt for that repository, PR and id whose words hold the quote. #110: the digest (rulingContentDigest, lib/triage.mjs) binds
// the request to the finding text the owner was shown; owner-ruling recomputes it. A line without one (the shape before #110) is
// still read, with content null, and owner-ruling refuses it. Returns { pr, repo (lower case), ids, content (lower case hex, or null) }
// or null when the reply does not end with that line.
const RULING_LINE = new RegExp(`^\\s*⚖️?\\s*Owner ruling needed\\s+#(\\d{1,6})\\s*:\\s*([^\\n·|]+?)\\s*(?:(?:·|\\|)\\s*content\\s+([0-9a-f]{12})\\s*)?(?:·|\\|)\\s*repo\\s+(${REPO_NAME})\\s*$`, 'i');
const ITEM_ID = /^R\d{1,4}-[A-Za-z]{1,8}\d{1,4}$/;
export function presentedRuling(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const m = RULING_LINE.exec(lines[lines.length - 1] ?? '');
  if (!m) return null;
  const ids = [...new Set(m[2].split(/[\s,]+/).filter(Boolean))];
  if (ids.length === 0 || !ids.every((id) => ITEM_ID.test(id))) return null;
  return { pr: Number(m[1]), repo: m[4].toLowerCase(), ids, content: m[3] ? m[3].toLowerCase() : null };
}

// ---- the transcript: what a prompt entry is, who it came from ---------------------------------------------------------------------

const plain = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
// (round 4: a user message is a prompt unless it carries a tool_result: an image-only message is one too, with no text)
const isPromptEntry = (e) => e?.type === 'user' && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && !e.message.content.some((b) => b?.type === 'tool_result')));
const promptTextOf = (e) => {
  const c = e?.message?.content;
  return plain(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
};

// Where a transcript PROMPT entry came from, from its metadata only, never its text (#128; Claude Code 2.1.314 writes origin {kind},
// promptSource, turnOrigin and entrypoint on a prompt entry, probed 2026-11-03):
//   'synthetic': promptSource system (task notices, peers, plugins, scheduled turns) or sdk (headless `claude -p`, also `--resume` of this
//     session), entrypoint sdk-cli, or an origin.kind that is not human;
//   'owner': origin.kind human or promptSource typed / queued, and none of the above;
//   'unknown': no such field (an older Claude Code; `!` blocks). `isMeta` alone decides nothing: an owner prompt with an attachment may carry it.
// A user entry that carries a tool_result is no prompt, so never the owner's.
export function entrySource(e) {
  if (!isPromptEntry(e)) return 'synthetic';
  const kind = typeof e.origin?.kind === 'string' ? e.origin.kind : '';
  if (e.promptSource === 'system' || e.promptSource === 'sdk' || e.entrypoint === 'sdk-cli' || (kind !== '' && kind !== 'human')) return 'synthetic';
  if (kind === 'human' || e.promptSource === 'typed' || e.promptSource === 'queued') return 'owner';
  return 'unknown';
}
// Does the entry carry any of the fields entrySource reads? A transcript with such a field on some prompt is a modern one; an entry
// of 'unknown' source in it is not trusted (an interrupt marker, a compaction summary, a source this list does not know).
const hasProvenanceField = (e) => e.promptSource !== undefined || e.origin !== undefined || e.entrypoint !== undefined || e.turnOrigin !== undefined;

// The parsed entries of the transcript's last `tailBytes` (a cut first line dropped); [] when it cannot be read as a regular file.
function tailEntries(transcriptPath, tailBytes) {
  let raw = '';
  try {
    if (!lstatSync(transcriptPath).isFile()) return [];
    const fd = openSync(transcriptPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      raw = buf.toString('utf8');
      if (len < size) raw = raw.slice(raw.indexOf('\n') + 1); // drop the cut first line
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
  }
  return out;
}

// The text of the last assistant reply in the transcript when it holds a 🔀 merge request ('' when none). Only the
// transcript's last 4 MB are read. A reply is every assistant text block between two prompts.
// `prompt` is the text being submitted (the UserPromptSubmit hook's input.prompt). Why (#58 round 3): the hook may run before or after the
// transcript gets that prompt, so the newest prompt entry is "the current one" (its empty slot skipped) only when its text IS that prompt;
// any other newest prompt is an older, unanswered one, and the empty reply slot after it is the reply to use: no request, the one before is stale.
// Without `prompt` the newest prompt entry is taken to be the current one.
export function lastRequestText(transcriptPath, opts = {}) {
  const text = lastReplyText(transcriptPath, opts);
  return READY_LINE.test(text) ? text : '';
}
// The same reply, whatever it ends with ('' when there is none).
// #128 skipSynthetic (rulings only; a merge request stays strict): a prompt entry whose METADATA says synthetic (entrySource, never its
// text) opens no reply slot, and every assistant text after it up to the next other prompt is dropped, so the owner can answer a ruling
// ask after a background notice and the agent's reply to it, and a ruling or 🔀 line printed in that reply binds nothing. An owner prompt
// or one of unknown source is a boundary as before, so a pasted `<task-notification>` typed by the owner keeps its boundary.
// R1-F3 (the limit): a dropped reply may itself have shown a NEWER ask (the agent can start a synthetic turn at will, with a background task), and the owner
// answers the ask they last saw. So a dropped reply that holds a ruling line or a 🔀 line voids the pending slot: '' (the owner is asked again, the nudge fires).
// R2-F2: the agent is the untrusted party and picks its wording ("For #59 please answer R1-B1: accept or reject" has neither line), so the test is wider and fails
// towards voiding: a finding id anywhere in the reply, or a decision word together with a PR reference. An ordinary reply to a notice ("The build finished.") has neither.
const SHOWS_ASK = /Owner ruling needed\s+#\d/i;
const FINDING_ID_TEXT = /\bR\d{1,4}-[A-Za-z]{1,8}\d{1,4}\b/i;
const DECISION_WORD = /\b(?:accept|reject|follow[- ]?up|approve|merge)\b/i;
const PR_REF = /#\d|\bpr\s*\d/i;
const showsAsk = (text) => SHOWS_ASK.test(text) || READY_LINE.test(text) || FINDING_ID_TEXT.test(text) || (DECISION_WORD.test(text) && PR_REF.test(text));
export function lastReplyText(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES, prompt, skipSynthetic = false } = {}) {
  const replies = [''];
  const voided = new Set(); // slots (indexes of replies) whose ask a dropped reply replaced
  let lastIsPrompt = false; // is the newest user/assistant entry a prompt (the owner's current one)?
  let lastPromptText = '';
  let skipping = false; // inside a synthetic turn: its prompt and the replies to it
  for (const e of tailEntries(transcriptPath, tailBytes)) {
    const content = e?.message?.content;
    if (e?.type === 'user') {
      const isPrompt = isPromptEntry(e);
      if (isPrompt && skipSynthetic && entrySource(e) === 'synthetic') { skipping = true; continue; }
      if (isPrompt) skipping = false;
      else if (skipping) continue;
      if (isPrompt) {
        replies.push('');
        lastPromptText = promptTextOf(e);
      }
      lastIsPrompt = isPrompt;
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      if (skipping) {
        if (content.some((b) => b?.type === 'text' && typeof b.text === 'string' && showsAsk(b.text))) voided.add(replies.length - 1);
        continue;
      }
      lastIsPrompt = false;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') replies[replies.length - 1] += `${b.text}\n`;
    }
  }
  // Only the reply right before the owner's prompt: when the newest entry is that prompt, its own (empty) slot is skipped, and that is
  // the ONLY slot that may be. A later prompt plus a text-less assistant turn (tool calls only) leaves the old request stale, and an
  // older request is never revived by a later "merge": the agent shows it again.
  const current = lastIsPrompt && (prompt === undefined || plain(prompt) === lastPromptText);
  const last = replies.length - 1 - (current && replies.length > 1 ? 1 : 0);
  return voided.has(last) ? '' : (replies[last] ?? '');
}

// ---- #128: is this prompt the owner's words? --------------------------------------------------------------------------------------

// The openings of a prompt the harness (or another model) writes: a background-task notice, a system reminder, another session's or
// subagent's message, a plugin's. (The hook may run before the transcript has the entry, so the text is read too: a prompt the owner pastes
// that opens this way is not recorded either, and the owner is asked again.) And the blocks Claude Code writes for `!` commands and slash commands.
const ENVELOPE_START = /^(?:<task-notification>|<system-reminder>|Another Claude session sent a message:|The [\w.-]{1,64} plugin sent a message:)/;
const SHELL_BLOCK_OPEN = /^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)>/;
function onlyShellBlocks(text) {
  let rest = text.trim();
  if (rest === '') return false;
  while (rest !== '') {
    const m = SHELL_BLOCK_OPEN.exec(rest);
    const end = m ? rest.indexOf(`</${m[1]}>`, m[0].length) : -1;
    if (end < 0) return false;
    rest = rest.slice(end + m[1].length + 3).trimStart();
  }
  return true;
}
const textEnvelope = (prompt) => {
  const t = String(prompt ?? '').trim();
  return ENVELOPE_START.test(t) || onlyShellBlocks(t);
};

// Is the CURRENT submission already in the transcript as a synthetic entry? The newest user/assistant entry must be a prompt (no reply after
// it: lastReplyText's `current`) whose text is this prompt. An older entry with the same text that has been answered lends nothing.
function currentEntryIsSynthetic(transcriptPath, prompt) {
  const entries = tailEntries(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'user' && e?.type !== 'assistant') continue;
    return isPromptEntry(e) && promptTextOf(e) === plain(prompt) && entrySource(e) === 'synthetic';
  }
  return false;
}

// "Never record this prompt" (both recorders; the safe side is to record less). True when the hook input itself says it is not typed
// (no such field is known to exist, so this is future-proofing), when the transcript already holds this submission as a synthetic entry, or
// when the text is a harness envelope. A genuine owner answer lost to a false match is asked again (the hook's nudge), never silently taken.
export function notOwnerWords(input, transcriptPath) {
  const kind = input?.origin?.kind;
  if ((typeof kind === 'string' && kind !== '' && kind !== 'human') || input?.promptSource === 'system' || input?.promptSource === 'sdk' || input?.isMeta === true) return true;
  if (textEnvelope(input?.prompt)) return true;
  return currentEntryIsSynthetic(transcriptPath, input?.prompt);
}

// Is this hook input a subagent's (or not a prompt at all)? Those never approve anything.
function notOwnerPrompt(input) {
  if (input?.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return true;
  if (input?.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '') return true;
  const tp = String(input?.transcript_path ?? '').replaceAll('\\', '/');
  return /\/subagents\//.test(tp);
}

const OPEN_APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Each folder from <home>/.claude down must be a real directory (a symlink would move the records elsewhere).
function realDirChain(home, rel) {
  let p = home;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return false;
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
      try { mkdirSync(p, { mode: 0o700 }); } catch { return false; }
      if (!lstatSync(p).isDirectory()) return false;
    }
  }
  return true;
}

// The recorder. Writes one line to <home>/.claude/pipeline-state/owner-go/<session>.jsonl for an owner prompt that approves;
// returns the record, or null (not an approval, a subagent, no session, or the write failed). Never throws.
export function recordApproval(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session)) return null;
    const a = parseApproval(input?.prompt);
    if (!a) return null;
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: a notice, a peer's or a scheduled turn's "merge")
    const shown = presentedRequests(lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt) }));
    const wanted = (pr) => a.prs.length === 0 || a.prs.includes(pr);
    const shaOk = (head) => a.shas.length === 0 || a.shas.some((s) => head.startsWith(s) || s.startsWith(head));
    const requests = shown.requests.filter((r) => wanted(r.pr) && shaOk(r.head));
    // PRs the owner approved for a direct merge: those the reply asked about (narrowed by the prompt), plus any the prompt names
    const prs = [...new Set([...shown.prs.filter(wanted), ...a.prs])];
    const record = {
      v: 1,
      ts: new Date(now()).toISOString(),
      session,
      prompt_sha256: createHash('sha256').update(String(input.prompt)).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      ...promptRefs(input),
      prs,
      requests,
    };
    return appendRecord(home, session, record);
  } catch {
    return null;
  }
}

// What lets the USE side find this prompt's transcript entry again (#128): the hook's prompt_id (the entry's promptId), the transcript, and the
// words themselves (the fallback for a hook that sends no prompt_id; a "merge" is short, a ruling answer is capped by RULING_PROMPT_MAX).
const promptRefs = (input) => ({
  prompt_id: typeof input?.prompt_id === 'string' && input.prompt_id !== '' ? input.prompt_id : null,
  transcript_path: typeof input?.transcript_path === 'string' && input.transcript_path !== '' ? input.transcript_path : null,
  prompt: typeof input?.prompt === 'string' && input.prompt.length <= RULING_PROMPT_MAX ? input.prompt : null,
});

// Appends one record to <home>/.claude/pipeline-state/owner-go/<session>.jsonl; the record, or null when it cannot be written safely.
function appendRecord(home, session, record) {
  if (!realDirChain(home, OWNER_GO_REL)) return null;
  const file = path.join(ownerGoDir(home), `${session}.jsonl`);
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
  }
  const fd = openSync(file, OPEN_APPEND, 0o600);
  try {
    if (!fstatSync(fd).isFile()) return null;
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return record;
}

export const RULING_PROMPT_MAX = 1000; // a ruling answer is only decisions (rulingsIn); a longer prompt is no answer and is not recorded (never cut)

// Phase 3b, the ruling recorder (same hook, same folder): when the reply right before the owner's prompt ends with the ruling line
// (presentedRuling), writes the prompt's words, bound to that repository, PR and those item ids. Returns the record, or null. Never throws.
export function recordRuling(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session) || typeof input?.prompt !== 'string' || input.prompt.trim() === '' || input.prompt.length > RULING_PROMPT_MAX) return null;
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: a notice, a peer's or a scheduled turn's words)
    const asked = presentedRuling(lastReplyText(String(input?.transcript_path ?? ''), { prompt: input.prompt, skipSynthetic: true }));
    if (!asked) return null;
    return appendRecord(home, session, {
      v: 1, kind: 'ruling', ts: new Date(now()).toISOString(), session,
      prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      repo: asked.repo, pr: asked.pr, ids: asked.ids, content: asked.content, ...promptRefs(input), prompt: input.prompt,
    });
  } catch {
    return null;
  }
}

// #128, the hook's nudge: the owner's prompt reads as a ruling answer (only `<id>: <decision>` pairs, rulingsIn's form) but recordRuling wrote
// nothing, because the reply before it did not end with the ⚖️ line (a notice, a `!` command or a tool-only turn came between, or the agent never
// asked). Said once to the agent, never blocking: it must ask again with a fresh `P triage ruling-request`. Not said for a prompt that is evidently
// not the owner's (notOwnerWords), so a notification loop cannot make the agent ask itself.
export const RULING_NUDGE = '[claude-pipeline owner-go] this reads as a ruling answer, but no ruling was recorded for it. A ruling is recorded only when the reply right before it ends with the "⚖️ Owner ruling needed" line: run `P triage ruling-request` again and ask once more.';
export function rulingNudge(input) {
  try {
    if (notOwnerPrompt(input) || !SESSION_RE.test(String(input?.session_id ?? ''))) return null;
    const answer = input?.prompt;
    if (typeof answer !== 'string' || answer.length > RULING_PROMPT_MAX || !PAIRS_ONLY.test(answer.replace(/\s+/g, ' ').trim())) return null;
    return notOwnerWords(input, String(input?.transcript_path ?? '')) ? null : RULING_NUDGE;
  } catch {
    return null;
  }
}

// Every valid "merge" record younger than maxAgeMs, from one session's file or (session null) from all of them. Never throws.
export function readApprovals(opts = {}) {
  return readRecords(opts).filter((r) => r.kind === undefined).map((r) => ({
    ts: r.ts,
    session: r.session,
    prompt_id: typeof r.prompt_id === 'string' ? r.prompt_id : null,
    transcript_path: typeof r.transcript_path === 'string' ? r.transcript_path : null,
    prompt: typeof r.prompt === 'string' ? r.prompt : null,
    prs: Array.isArray(r.prs) ? r.prs.filter(Number.isInteger) : [],
    requests: Array.isArray(r.requests) ? r.requests.filter((q) => Number.isInteger(q?.pr) && typeof q.head === 'string' && typeof q.items === 'string').map((q) => ({ ...q, repo: typeof q.repo === 'string' ? q.repo : null })) : [],
  }));
}

// Every valid record (any kind) younger than maxAgeMs, as written. Never throws.
function readRecords({ home = accountHome(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  const dir = ownerGoDir(home);
  const out = [];
  let names = [];
  try {
    if (!lstatSync(dir).isDirectory()) return out;
    names = session === null ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')) : SESSION_RE.test(String(session)) ? [`${session}.jsonl`] : [];
  } catch {
    return out;
  }
  const t = now();
  for (const name of names) {
    const file = path.join(dir, name);
    let text = '';
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) continue;
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const buf = Buffer.alloc(st.size);
        readSync(fd, buf, 0, st.size, 0);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.v !== 1 || `${r.session}.jsonl` !== name) continue;
      const at = Date.parse(r.ts);
      if (!Number.isFinite(at) || at > t + FUTURE_SKEW_MS || t - at > maxAgeMs) continue;
      out.push(r);
    }
  }
  return out;
}

// The repository as the records hold it (owner/name, lower case; GitHub names are case-insensitive), or null when `repo` is none.
export const repoKey = (repo) => (typeof repo === 'string' && new RegExp(`^${REPO_NAME}$`).test(repo) ? repo.toLowerCase() : null);

// ---- #128: use-time provenance ------------------------------------------------------------------------------------------------------
// The recorder cannot always tell who wrote a prompt (the hook input has no such field and the transcript may lag), so every consumer asks
// again when it uses a record: is the transcript entry of that prompt the owner's? Found by the hook's prompt_id (the entry's promptId) among
// PROMPT entries only (a tool_result sharing the id is no prompt); two prompt entries with one id is a replayed or forged id: synthetic.
// A record without prompt_id (a hook that sends none) is matched by its stored words within FALLBACK_WINDOW_MS of the record, same rule.
// Returns 'owner', 'synthetic', or 'missing' (no such entry within PROVENANCE_CAP_BYTES of the end, or the transcript is not a readable regular
// file, or one of a shape the guard does not write-protect: R1-B2, lib/paths.mjs isTranscriptFile, the ONE definition files-policy.mjs protects by: a file the
// guard leaves writable is not evidence of who typed anything, so a transcript_path elsewhere, or in a config dir the environment does not name, is refused here).
// An entry of unknown source (no provenance field) counts as the owner's ONLY when no prompt in the scanned transcript carries any
// such field (a genuinely old Claude Code); in a modern transcript it is untrusted, and so is an unknown one when the scan fell short of the start.
export function promptProvenance(record, { chunkBytes = PROVENANCE_CHUNK_BYTES, capBytes = PROVENANCE_CAP_BYTES, env = process.env } = {}) {
  const file = record?.transcript_path;
  if (typeof file !== 'string' || file === '' || !path.isAbsolute(file) || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { env })) return 'missing';
  let match;
  if (typeof record.prompt_id === 'string' && record.prompt_id !== '') {
    const id = record.prompt_id;
    match = { wants: (line) => line.includes(id), is: (e) => isPromptEntry(e) && e.promptId === id };
  } else if (typeof record.prompt === 'string' && record.prompt.trim() !== '') {
    const at = Date.parse(record.ts);
    const words = plain(record.prompt);
    if (!Number.isFinite(at)) return 'missing';
    match = { wants: (line) => line.includes('"user"'), is: (e) => isPromptEntry(e) && promptTextOf(e) === words && Math.abs(Date.parse(e.timestamp) - at) <= FALLBACK_WINDOW_MS };
  } else {
    return 'missing';
  }
  const found = [];
  const scan = scanBackwards(file, (e) => { if (match.is(e)) found.push(e); return found.length >= 2; }, match.wants, { chunkBytes, capBytes });
  if (scan === null || found.length === 0) return 'missing';
  if (found.length > 1) return 'synthetic';
  const source = entrySource(found[0]);
  if (source !== 'unknown') return source;
  // unknown: legacy only if the whole transcript is free of provenance fields
  let modern = false;
  const whole = scanBackwards(file, (e) => { if (isPromptEntry(e) && hasProvenanceField(e)) modern = true; return modern; }, (line) => line.includes('"user"'), { chunkBytes, capBytes });
  return whole !== null && whole.reachedStart && !modern ? 'owner' : 'synthetic';
}

// Visits the parsed lines of a file newest first, in chunk-sized reads, at most capBytes back from the end; `wants(line)` filters before the
// parse and `visit(entry)` returns true to stop. Returns { reachedStart } (did the scan cover the whole file?) or null when it cannot be read.
function scanBackwards(file, visit, wants, { chunkBytes, capBytes }) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let pos = fstatSync(fd).size;
    let scanned = 0;
    let carry = Buffer.alloc(0); // the front of the line that continues into the chunk before
    while (pos > 0 && scanned < capBytes) {
      const len = Math.min(chunkBytes, pos, capBytes - scanned);
      pos -= len;
      scanned += len;
      const chunk = Buffer.alloc(len);
      for (let got = 0; got < len;) {
        const n = readSync(fd, chunk, got, len - got, pos + got);
        if (n <= 0) return null;
        got += n;
      }
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let from = 0;
      carry = Buffer.alloc(0);
      if (pos > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) { carry = data; continue; }
        carry = data.subarray(0, nl);
        from = nl + 1;
      }
      const lines = data.subarray(from).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim() || !wants(lines[i])) continue;
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (visit(e) === true) return { reachedStart: false };
      }
    }
    return { reachedStart: pos === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

// The records of `list` whose prompt is the owner's (each distinct prompt is looked up once).
function ownedBy(list) {
  const memo = new Map();
  return list.filter((r) => {
    const key = `${r.transcript_path}\0${r.prompt_id}\0${r.prompt}\0${r.ts}`;
    if (!memo.has(key)) memo.set(key, promptProvenance(r));
    return memo.get(key) === 'owner';
  });
}

// P merge: did the owner say "merge" for exactly this repository (owner/name), PR, full head and owner-item set (any session, last 24 h),
// and is that prompt the owner's (promptProvenance)? approvalGap says why not: 'provenance' (a matching record exists but no owner prompt
// stands behind it), 'none' (no matching record), 'ok'.
export function approvalGap({ repo, pr, head, items, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return 'none';
  const matching = readApprovals(opts).filter((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items));
  if (matching.length === 0) return 'none';
  return ownedBy(matching).length > 0 ? 'ok' : 'provenance';
}
export const approvedRequest = (q) => approvalGap(q) === 'ok';

// The guard, before a direct merge: did the owner say "merge" in this session (last 24 h) for a request about this repository and PR
// whose head is this full head? (A PR merely named in the prompt, `merge #7`, is recorded in `prs` for the audit trail but approves no head.)
export function approvedPr({ repo, pr, head, session, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(String(head)) || !SESSION_RE.test(String(session ?? ''))) return false;
  return ownedBy(readApprovals({ ...opts, session }).filter((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head)))).length > 0;
}

// What an owner's answer to a ruling request decides, per item. Security reviews of f17b251, ff8090f and 009d435: reading decisions
// out of free text (a fragment, a word read for the wrong item, "don't accept", a contradicting word left over) always left a way to
// pass words for a ruling the owner did not give, so the answer is now ONLY the decisions, nothing else: `R1-B1: accept, R2-S3: reject`
// (each asked id at most once; `:` `-` `=` or a space between id and decision; commas, semicolons, full stops, `and` between pairs).
// The id is always written (Fable attacker pass: the ruling line is the agent's, so a bare "accept" answering an unrelated question
// under it would rule). Any other word, an id not asked, or an id twice, and the answer decides nothing (the owner's reasons go in
// another message). Returns Map(ID upper case → ACCEPT | FOLLOW-UP | REJECT).
const DECISION = '(accept|follow[- ]?up|reject)';
const ITEM = '(r\\d{1,4}-[a-z]{1,8}\\d{1,4})';
const decisionOf = (w) => (/^accept/i.test(w) ? 'ACCEPT' : /^reject/i.test(w) ? 'REJECT' : 'FOLLOW-UP');
const SEP = '(?:\\s*[,;.]\\s*|\\s+and\\s+|\\s+)';
const PAIR = `${ITEM}\\s*[:=–—-]?\\s*${DECISION}`;
const PAIRS_ONLY = new RegExp(`^${PAIR}(?:${SEP}${PAIR})*[.!]?$`, 'i');
export function rulingsIn(answer, askedIds) {
  const a = String(answer ?? '').replace(/\s+/g, ' ').trim();
  const asked = (askedIds ?? []).map((x) => String(x).toUpperCase());
  const out = new Map();
  if (!PAIRS_ONLY.test(a)) return out;
  for (const [, id, d] of a.matchAll(new RegExp(PAIR, 'gi'))) {
    const k = id.toUpperCase();
    if (!asked.includes(k) || out.has(k)) return new Map();
    out.set(k, decisionOf(d));
  }
  return out;
}

// Every ruling record (any session, last 24 h) that answers a ruling request for this repository, PR and item with exactly `quote` (the
// WHOLE answer; runs of white space as one space, case-insensitive: it is copied from the chat) and decides `decision` for the item (rulingsIn).
function rulingsFor({ repo, pr, id, quote, decision, ...opts }) {
  const key = repoKey(repo);
  const words = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = words(quote);
  if (key === null || !Number.isInteger(pr) || q === '') return [];
  return readRecords(opts).filter((r) => r.kind === 'ruling' && r.repo === key && r.pr === pr && Array.isArray(r.ids) && r.ids.includes(id)
    && typeof r.prompt === 'string' && words(r.prompt) === q && rulingsIn(r.prompt, r.ids).get(String(id).toUpperCase()) === decision);
}

// triage owner-ruling: did the owner answer a ruling request for this repository, PR and item (rulingsFor), and is the finding text the
// owner was shown (the request's `content`) still the current one? #110: `contentOf(ids)` is the caller's digest of those items in the
// current review state (null when any is gone); it is called with the record's FULL id list, and a record with no content (the line
// shape before #110) or no `contentOf` approves nothing.
// #128: only a record whose prompt is the owner's (promptProvenance) counts.
export function ownerRuled({ contentOf, ...q }) {
  return typeof contentOf === 'function' && ownedBy(rulingsFor(q)).some((r) => typeof r.content === 'string' && r.content === contentOf(r.ids));
}

// Why ownerRuled said no, for the message: 'none' (no such answer recorded), 'provenance' (answers exist but none is confirmed as typed by
// the owner: checked first), 'no-content' (every one is in the old line shape) or 'changed' (the finding text differs from the one the owner
// was asked about).
export function ownerRulingGap(q) {
  const found = rulingsFor(q);
  if (found.length === 0) return 'none';
  const owned = ownedBy(found);
  if (owned.length === 0) return 'provenance';
  return owned.every((r) => typeof r.content !== 'string') ? 'no-content' : 'changed';
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}
