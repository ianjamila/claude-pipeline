// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which fires for the owner's typed prompts and for harness turns, which #128 screens out) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest> · repo <owner/name>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval). The block may also carry an
//   `Areas …` line (protected areas) and a `Hold … by … at …` line with the lift wording on the 🔀 line (the needs-human hold the "merge" lifts): see presentedRequests.
// `P merge` then needs a record for exactly that repository, PR, head and owner-item set; the guard needs one (for that repository and
// PR, in that session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. Phase 3b: the repository
// is part of the request, so a "merge" said for #N of one repository never approves #N of another (a fork, a mirror, a vendored copy
// that shares the commit). A request line without it approves nothing. guard-files keeps
// agents from writing the folder or running the recorder.
// #128 (harness messages are not the owner's words): UserPromptSubmit also fires for background-task notices, other sessions' and
// subagents' messages, plugin and scheduled (/loop) turns and headless `claude -p` runs, and its input carries no field that says which.
// Two defences, both "record less": (1) the recorders skip a prompt that is evidently not typed (notOwnerWords: hook-input provenance, the
// transcript entry once it exists, a text envelope), and the ruling look-back skips turns the TRANSCRIPT METADATA marks synthetic
// (entrySource: never text); (2) at USE time, when the transcript has caught up, `P merge`, the guard, `P triage owner-ruling` and the
// owner-granted extra round (ownerGrantedRounds, the final gate's verifyOwnerGrant) accept a record only when its prompt entry (found by the hook's prompt_id, else by text and time) is the owner's (promptProvenance).
// A record whose entry cannot be found or is not the owner's approves nothing. Records written before #128 carry no prompt_id (nor transcript_path):
// a "merge" or a ruling from then is refused for its last day at most (it ages out, MAX_AGE_MS). An owner-granted extra round is different: it is read
// at any age (verifyOwnerGrant), so a pre-#128 grant on a PR still in flight would block its review-complete and final gate for good. The grant readers
// therefore find such a record's transcript from its session (legacyTranscriptOf: exactly one real file under the ROOTS THE GUARD PROTECTS, else missing: the folders
// directly under the account's home named like ~/.claude, ~/.claude-eaglewatch (HOME_CONFIG_DIR_RE, the shape the guard stops a tool from creating or replacing), the file's real
// path inside its root's; never $CLAUDE_CONFIG_DIR, which the grant readers take from the agent's shell, never ~/.claude.forged, which nothing stops) and prove
// the prompt by its words and time like any record without a prompt_id; the derived path is never written back. Nothing else gets this.
// Residual (#128): the model could still write a transcript entry itself (files-policy refuses a tool write to ~/.claude*/projects/**/*.jsonl)
// or type into an interactive `claude --resume` through a pty, which types as the owner; GitHub-side separation (issue #65) is the backstop.
// Residual (owner ruling 2026-10-14, the "cheap step"): the agent runs as the same OS user, so a program the guards cannot
// see into can still write the folder; the transcript the recorder reads is a file of that user; and the agent's GitHub
// token is the owner's. A second GitHub identity + a ruleset is the server-side backstop (issue #65).
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { accountHome, isInside, isTranscriptFile, TRANSCRIPT_PROJECT_RE, transcriptConfigDirs } from '../../lib/paths.mjs';

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
// can write. (The `home` options below are for the unit tests, which call these functions in-process.) Defined in lib/paths.mjs, where isTranscriptFile needs the same home.
// (The guard itself, hooks/lib/files-policy.mjs, builds its home from os.homedir(): where $HOME differs from the passwd home it protects the $HOME one, so a genuine transcript under the passwd home
// is refused here. Fail closed, accepted.)
export { accountHome };

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
// lines (or, for several PRs, `#N head <sha12> · items <digest> · repo <owner/name>`) directly above the 🔀 line, which is the last non-blank line. Blank (whitespace-only) lines
// anywhere in the reply are transparent ("directly above" = the next non-blank line above; EW #1659: a blank line before the 🔀 line voided the owner's "merge"); prose is not.
// Only that terminal block binds: an earlier block in the same reply, a Head line with prose between it and the 🔀 line, or any
// text after the 🔀 line binds nothing, and a PR bound twice (two heads, or the same line twice) is ambiguous, so it binds nothing.
// Protected areas (plan 2026-11-05-chat-merge-protected, rev 4 item 2b): a PR whose diff has owner items is shown with one more line DIRECTLY above its
// Head line (or directly above the Hold line that sits directly above its Head line), `Areas <area ids, sorted, one space apart>` (areasBlock: the hard-stop rule ids / integrity kinds
// P merge --dry-run prints), and the record keeps sha256 of that block (areasDigest). In the several-PR form it is `#N areas <ids>` above `#N head …`. Exactly that shape binds: an Areas
// line that is not directly above its own Head line or Hold line (two in a row, one against the 🔀 line, another PR's number) makes the whole block bind nothing. An Areas line with
// prose between it and the Head line is no part of the block: the request then binds WITHOUT areas, which approves no diff that has any.
// The needs-human hold (rev 4 items 2a, 5; review note 6): a PR whose hold the owner's "merge" lifts has the Head line carry ONE `· hold <event id>` field between
// `items …` and `repo …`, and a canonical `Hold <id> by <login> at <ISO>` line (holdBlock) DIRECTLY above that Head line. Block order, top to bottom: Areas (optional),
// Hold, Head; Areas binds above Head or above a Hold that sits above its Head. UNLIKE Areas, ANY Hold-shaped line anywhere in the reply that is not consumed exactly so
// (malformed, prose between it and its Head, two in a row, against the 🔀 line, ahead of Areas, another PR's, an id other than its Head's `hold` field) makes the WHOLE reply
// bind nothing, and so does a Head line with `hold X` and no Hold line right above it; a hold field repeated or after `repo` is no Head line at all. The record keeps the hold
// id and sha256 of the block (holdDigest). And a request with a hold binds only when the 🔀 line says it lifts the hold (readyLine, LIFT_PHRASE): the phrase with no hold
// in the block, or a hold with no phrase, binds nothing.
// Returns { prs: [N…] (every PR on the 🔀 line; [] when the reply does not end with it), requests: [{ pr, head, items, repo, areas?, hold?, holdBlock? }] } (repo: the
// lower-cased owner/name, or null when the line names none: such a request approves nothing; areas: the block's digest, absent = no areas shown; hold: the event id,
// holdBlock: the Hold block's digest, both absent = no hold).
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
const REPO_NAME = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const HOLD_ID = '[A-Za-z0-9_=+/-]{1,128}';
const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)(?:\\s*(?:·|\\|)\\s*hold\\s+(${HOLD_ID}))?(?:\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME}))?\\s*$`, 'i');
const AREAS_START = /^\s*(?:#\d+\s+)?areas\b/i;
const AREA_ID = '[A-Za-z0-9_.-]{1,64}';
const AREAS_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?areas((?:\\s+${AREA_ID})+)\\s*$`, 'i');
// "Hold-shaped" is the canonical PREFIX only (`Hold <id> by `, an optional `#N ` before it, any case): prose that merely starts with the word ("Hold on, a second.") is no Hold line.
const HOLD_START = /^\s*(?:#\d+\s+)?hold\s+\S+\s+by\s+/i;
// (GitHub logins: letters, digits, hyphens, an optional `[bot]`. A `_` (an EMU login) is rejected on purpose: such a hold has no showable block, so the request fails closed.)
const HOLD_LOGIN = '[A-Za-z0-9-]{1,39}(?:\\[bot\\])?';
const HOLD_AT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
const HOLD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?hold\\s+(${HOLD_ID})\\s+by\\s+(${HOLD_LOGIN})\\s+at\\s+(${HOLD_AT})\\s*$`, 'i');
// The canonical block the owner is shown for the areas of a diff: `Areas <sorted distinct ids>`; '' when there are none.
export const areasBlock = (ids) => {
  const list = [...new Set((ids ?? []).map(String))].sort();
  return list.length === 0 ? '' : `Areas ${list.join(' ')}`;
};
// What the record stores for it and P merge compares: sha256 of the block, 'none' without areas.
export const areasDigest = (ids) => {
  const block = areasBlock(ids);
  return block === '' ? 'none' : createHash('sha256').update(block).digest('hex');
};
// The canonical block the owner is shown for the needs-human hold their "merge" lifts: `Hold <event node id> by <actor login> at <created_at>` (the id and login as GitHub
// spells them, the time exactly as GitHub's created_at: ISO-8601 UTC, whole seconds). '' for input of another shape: a caller treats '' as "no showable hold" and fails closed.
export const holdBlock = (hold) => {
  const { id, login, at } = hold ?? {};
  return typeof id === 'string' && typeof login === 'string' && typeof at === 'string'
    && new RegExp(`^${HOLD_ID}$`).test(id) && new RegExp(`^${HOLD_LOGIN}$`).test(login) && new RegExp(`^${HOLD_AT}$`).test(at)
    ? `Hold ${id} by ${login} at ${at}` : '';
};
// What the record stores for it and P merge compares: sha256 of the block; 'none' for no hold (null / absent); 'invalid' for a hold with no showable block (it equals no record's value).
export const holdDigest = (hold) => {
  if (hold === null || hold === undefined) return 'none';
  const block = holdBlock(hold);
  return block === '' ? 'invalid' : createHash('sha256').update(block).digest('hex');
};
// The 🔀 line a request ends with. A request whose Head line has a hold ends with the lift phrase (rev 4 item 2a), exactly: `🔀 Ready to merge #N and lift its needs-human hold — say "merge"`,
// or for several PRs `🔀 Ready to merge #1, #2 and lift their needs-human holds — say "merge"`. presentedRequests binds a hold only under that wording (a dash as `-` / `--` or a final full stop also read).
export const LIFT_PHRASE = Object.freeze({ one: 'and lift its needs-human hold', many: 'and lift their needs-human holds' });
export const readyLine = (prs, { lift = false } = {}) => `🔀 Ready to merge ${prs.map((n) => `#${n}`).join(', ')}${lift ? ` ${prs.length === 1 ? LIFT_PHRASE.one : LIFT_PHRASE.many}` : ''} — say "merge"`;
const LIFT_LINE = new RegExp(`^(#\\d{1,6}(?:\\s*,\\s*#\\d{1,6})*)\\s+(${LIFT_PHRASE.one}|${LIFT_PHRASE.many})\\s*(?:—|\\s--?\\s)\\s*say\\s+"merge"\\.?\\s*$`);
const liftsHold = (rest, prs) => {
  const m = LIFT_LINE.exec(rest.trim());
  return m !== null && m[2] === (prs.length === 1 ? LIFT_PHRASE.one : LIFT_PHRASE.many); // (the PR numbers in m[1] are the text `prs` was read from)
};
export function presentedRequests(text) {
  const none = (prs) => ({ prs, requests: [] });
  // A whitespace-only line carries no content, so it is transparent: "directly above" means the next NON-BLANK line above (owner-reported miss, EW #1659: a blank line between the
  // Head line and the 🔀 line made the owner's "merge" record nothing). Prose still ends the block, and every rule below is unchanged.
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const r = READY_LINE.exec(lines[lines.length - 1] ?? '');
  if (!r) return { prs: [], requests: [] };
  const prs = [...new Set([...r[1].split(/—|\s--?\s|\bsay\b/)[0].matchAll(/#(\d{1,6})\b/g)].map((x) => Number(x[1])))];
  const block = [];
  let i = lines.length - 2;
  for (; i >= 0; i--) {
    if (lines[i].includes('\r')) break; // a lone \r (CRLF was split off above) redraws the line on a terminal: what the owner sees is not what the parser would read, so it is prose
    const h = HEAD_LINE.exec(lines[i]);
    const a = h ? null : AREAS_LINE.exec(lines[i]);
    const o = h || a ? null : HOLD_LINE.exec(lines[i]);
    if (!h && !a && !o) break;
    block.unshift({ h, a, o });
  }
  if (i >= 0 && AREAS_START.test(lines[i])) return none(prs); // an Areas line of any other shape against the block: malformed
  if (lines.slice(0, i + 1).some((l) => HOLD_START.test(l))) return none(prs); // a canonical-prefix Hold line outside the block (prose between it and its Head, an earlier block's): review note 6
  const bound = new Map();
  for (let j = 0; j < block.length; j++) {
    const { h } = block[j];
    if (!h) continue;
    const hold = h[4] ?? null;
    const o = block[j - 1]?.o ?? null; // the Hold line right above (null: none)
    if ((hold === null) !== (o === null)) return none(prs); // a hold field with no Hold line right above, or a Hold line above a Head line without the field
    let hasHold = null;
    if (o) {
      if ((o[1] ?? null) !== (h[1] ?? null) || o[2] !== hold) return none(prs); // another PR's Hold line, or another hold's id
      const rebuilt = { id: o[2], login: o[3], at: o[4] };
      if (holdBlock(rebuilt) === '') return none(prs); // (the regex reads T / Z in any case; the block is canonical only in upper case)
      hasHold = rebuilt;
    }
    const above = o ? block[j - 2]?.a ?? null : block[j - 1]?.a ?? null;
    if (above && (above[1] ?? null) !== (h[1] ?? null)) return none(prs); // another PR's Areas line
    const pr = h[1] ? Number(h[1]) : prs.length === 1 ? prs[0] : null;
    if (pr === null || !prs.includes(pr)) continue;
    const areas = above ? createHash('sha256').update(`Areas ${above[2].trim().split(/\s+/).join(' ')}`).digest('hex') : null;
    bound.set(pr, bound.has(pr) ? null : { pr, head: h[2].toLowerCase(), items: h[3].toLowerCase(), repo: h[5] ? h[5].toLowerCase() : null, ...(areas ? { areas } : {}), ...(hasHold ? { hold: hasHold.id, holdBlock: holdDigest(hasHold) } : {}) });
  }
  // An Areas line that no Head line below it takes (a second one in a row, one against the 🔀 line) is a malformed block; so is a Hold line no Head line right below takes.
  const takesHead = (j) => block[j + 1]?.h || (block[j + 1]?.o && block[j + 2]?.h);
  if (block.some((b, j) => (b.a && !takesHead(j)) || (b.o && !block[j + 1]?.h))) return none(prs);
  // rev 4 item 2a: a hold binds only under the lift wording, and the wording only when EVERY request bound carries a hold (singular: the one PR; plural: all listed). A Hold-bearing
  // Head line that binds nothing itself (a PR not on the 🔀 line, an unprefixed Head in the several-PR form, a duplicate) neither makes the wording legitimate nor forbids it.
  const requests = [...bound.values()].filter(Boolean);
  if (liftsHold(r[1], prs) ? !prs.every((p) => bound.get(p)?.hold) : requests.some((x) => x.hold)) return none(prs);
  return { prs, requests };
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
// ask after a background notice the agent answered without text, and nothing the agent prints in such a reply binds. An owner prompt
// or one of unknown source is a boundary as before, so a pasted `<task-notification>` typed by the owner keeps its boundary.
// R1-F3 / R2-F2 / R3-B2 (the limit, owner decision 2026-11-03): a dropped reply may itself have shown a NEWER ask (the agent can start a synthetic turn at will, with a background
// task), and the owner answers the ask they last saw. The agent is the untrusted party and picks its wording ("For #59, what is your ruling on the first blocker?", "Tell me
// what to do about it"), so no test of WHAT the reply says can be complete: ANY non-empty text in a dropped reply voids the pending slot: '' (the owner is asked again, the nudge
// fires). The cost is one re-ask; a harness turn the agent answers with tool calls only (no text) leaves the ask standing, which is what skipSynthetic is for.
// R4-F3 (owner decision 2026-11-03): a tool-only reply can still SURFACE a newer ask, in the tool call (a Bash `ruling-request` command, an echoed
// ruling line) or in its result (a user entry with a tool_result block, which the owner sees in the tool box): a tool_use input or a tool_result that contains a ruling line,
// a merge line or a `head <sha> · items` line, or the command name `ruling-request`, voids the slot like text does.
// R5-B2 (owner decision 2026-11-04, option b): those canonical lines are NOT all the agent can show. It writes a tool_use input itself (`echo 'For PR #59, please answer R1-B1: accept or reject'`),
// so no fixed wording test is complete there either (the premise of R4-F3, that the lines are machine-printed, holds only for a result). A middle ground between voiding every tool-only reply
// (which would end skipSynthetic) and a wording test: tool input or result that ALSO holds a finding id, a PR reference, a decision word or a question mark voids the slot. The cost is one
// re-ask; a tool-only reply without any of them (`ls` and `file.txt`) still leaves the ask standing.
const showsText = (text) => text.trim() !== '';
const SURFACED_ASK = new RegExp(`Owner ruling needed\\s+#\\d|ruling-request|${READY_LINE.source}`, 'iu'); // (case-insensitive like RULING_LINE and HEAD_LINE: a detector narrower than the parsers lets a differently-cased ask through)
const ASK_WORDS = /(?<![\w])R\d{1,4}-[A-Za-z]{1,8}\d{1,4}(?![\w])|#\d|(?<![\w])PR\s*#?\d|(?<![\w])(?:accept|reject|follow-?up)(?![\w])|\?/iu; // (a finding id as ITEM_ID spells it, #N / PR N, a decision word, a question mark)
const surfacesAsk = (text) => SURFACED_ASK.test(text) || ASK_WORDS.test(text) || text.split(/\r?\n/).some((l) => HEAD_LINE.test(l));
// The text of a tool_result block's content (a string, or text blocks), or of a tool_use block's input.
const toolResultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
// A tool_use input as the owner reads it: the DECODED string values, one per line (JSON.stringify would re-escape a tab or a newline in a command to `\t` / `\n`, so a ruling
// line with a tab, or a `head … · items …` line inside a heredoc, would not be seen). Depth and total length are bounded; an input past either bound cannot be searched
// whole, and the agent writes it, so it fails closed: null, which voids the slot like a surfaced ask (padding must not hide a ruling line past the bound).
const TOOL_INPUT_MAX_DEPTH = 8;
const toolUseText = (input) => {
  const out = [];
  let size = 0;
  let over = false;
  const walk = (v, depth) => {
    if (over || v === null || v === undefined) return;
    if (size > MAX_RECORD_BYTES || depth > TOOL_INPUT_MAX_DEPTH) { over = true; return; }
    if (typeof v === 'string') { out.push(v); size += v.length; if (size > MAX_RECORD_BYTES) over = true; return; }
    if (typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  try { walk(input, 0); } catch { return null; }
  return over ? null : out.join('\n');
};
const inputSurfacesAsk = (input) => { const text = toolUseText(input); return text === null || surfacesAsk(text); };
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
      else if (skipping) {
        if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result' && surfacesAsk(toolResultText(b.content)))) voided.add(replies.length - 1);
        continue;
      }
      if (isPrompt) {
        replies.push('');
        lastPromptText = promptTextOf(e);
      }
      lastIsPrompt = isPrompt;
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      if (skipping) {
        if (content.some((b) => (b?.type === 'text' && typeof b.text === 'string' && showsText(b.text)) || (b?.type === 'tool_use' && inputSurfacesAsk(b.input)))) voided.add(replies.length - 1);
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
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

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
function readRecords({ home = accountHome(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS, maxBytes = MAX_RECORD_BYTES } = {}) {
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
      if (!st.isFile() || st.size > maxBytes) continue;
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
// file, or one of a shape the guard does not write-protect: R1-B2, lib/paths.mjs isTranscriptFile: a file the guard leaves writable is not evidence of who typed anything,
// so a transcript_path elsewhere is refused here). Codex #145 P1: "protected" means under a config ROOT the guard protects as one AND this check can trust: a folder directly under the account's
// home with the HOME_CONFIG_DIR_RE shape, NOT under any .claude* folder (a folder-level cp/tar/rsync into /tmp/.claude-x or ~/.claude.personal is not refused, so a forged transcript there would
// otherwise pass for the owner's words) and NOT $CLAUDE_CONFIG_DIR (this runs in the agent's shell: `CLAUDE_CONFIG_DIR=/tmp/.claude-x P merge`). `home` is the account's home (accountHome, never $HOME); tests pass a temp one.
// An entry of unknown source (no provenance field) counts as the owner's ONLY when no prompt in the scanned transcript carries any
// such field (a genuinely old Claude Code); in a modern transcript it is untrusted, and so is an unknown one when the scan fell short of the start.
export function promptProvenance(record, { chunkBytes = PROVENANCE_CHUNK_BYTES, capBytes = PROVENANCE_CAP_BYTES, home = accountHome() } = {}) {
  const file = record?.transcript_path;
  if (typeof file !== 'string' || file === '' || !path.isAbsolute(file) || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) return 'missing';
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

// A record written before #128 has no transcript_path: the one transcript of its session, or null. <config dir>/projects/<project>/<session>.jsonl, where the
// config dirs are ONLY the folders directly under the account's home with the guard's own shape (paths.mjs transcriptConfigDirs / HOME_CONFIG_DIR_RE: the names the guard
// refuses to let a tool create or replace, so what lies in them is the guard's). Why those and nothing else: the grant readers run in the agent's shell, so the
// environment is the agent's word. CLAUDE_CONFIG_DIR is ignored here (it would point the lookup at a file the agent wrote, and no guard reads that prefix), exactly as $HOME is
// (accountHome). A home-level name outside the shape (~/.claude.forged: `ln -s` creates it unguarded) is no root either. The candidate must be a regular file (not a link) of
// the shape isTranscriptFile accepts, not a subagent's, and its REAL path must lie inside the real path of one of those roots (a link inside a root that points out of
// them is not the guard's file; ~/.claude-eaglewatch/projects linked to ~/.claude/projects is), and taken relative to that root's real path it must be exactly
// projects/<project>/<session>.jsonl with <project> in the guard's project-folder shape (R2-B1: below ~/.claude the guard protects only projects/ and a project-shaped folder in it by NAME,
// so `ln -s ~/.claude/forged ~/.claude/projects/evil`, or a copy of it, is the agent's own file; the scan below lists only project-shaped names too, so the two agree).
// De-duplicated by real path (one account's projects/ can be a link to the other's). None, or two different files, is null.
// (A hook-written transcript_path record is judged the same way: isTranscriptFile / promptProvenance ignore $CLAUDE_CONFIG_DIR too, since the process that checks is the agent's shell.)
// Codex #145 P1: the isTranscriptFile test below gets the SAME `home` as the scan, so it accepts exactly these roots and no more: every dir transcriptConfigDirs lists is
// directly under that home with the HOME_CONFIG_DIR_RE shape, a root the guard protects (its home is the hook process's, the same account's).
const protectedShape = (rel, session) => { // rel: a real path relative to a root's real path
  const parts = rel.split(/[\\/]/);
  return parts.length === 3 && parts[0] === 'projects' && TRANSCRIPT_PROJECT_RE.test(parts[1]) && parts[2] === `${session}.jsonl`;
};
export function legacyTranscriptOf(session, { home = accountHome() } = {}) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) return null;
  const found = new Map(); // real path -> the path it was first seen by
  const dirs = transcriptConfigDirs({ home });
  const roots = []; // the roots' real paths
  for (const dir of dirs) { try { roots.push(realpathSync(dir)); } catch { /* gone */ } }
  for (const dir of dirs) {
    let projects;
    try { projects = readdirSync(path.join(dir, 'projects')); } catch { continue; }
    for (const project of projects) {
      if (!TRANSCRIPT_PROJECT_RE.test(project)) continue;
      const file = path.join(dir, 'projects', project, `${session}.jsonl`);
      try {
        if (!lstatSync(file).isFile() || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) continue;
        const real = realpathSync(file);
        if (!roots.some((r) => isInside(real, r) && protectedShape(path.relative(r, real), session))) continue;
        if (!found.has(real)) found.set(real, file);
      } catch { /* not there */ }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// The records of `list` whose prompt is the owner's (each distinct prompt is looked up once). grant: true (the extra-round readers) finds a pre-#128
// record's transcript by its session (legacyTranscriptOf) when it names none, under `home` only (the environment never says where).
function ownedBy(list, { grant = false, home } = {}) {
  const memo = new Map();
  return list.filter((r) => {
    const key = `${r.transcript_path}\0${r.prompt_id}\0${r.prompt}\0${r.ts}\0${grant ? r.session : ''}`;
    if (!memo.has(key)) {
      const derive = grant && (typeof r.transcript_path !== 'string' || r.transcript_path === '');
      const file = derive ? legacyTranscriptOf(r.session, { home }) : r.transcript_path;
      memo.set(key, derive && file === null ? 'missing' : promptProvenance(derive ? { ...r, transcript_path: file } : r, { home }));
    }
    return memo.get(key) === 'owner';
  });
}

// P merge: did the owner say "merge" for exactly this repository (owner/name), PR, full head and owner-item set (any session, last 24 h),
// and is that prompt the owner's (promptProvenance)? approvalGap says why not: 'provenance' (a matching record exists but no owner prompt
// stands behind it), 'none' (no matching record), 'ok'.
// `areas` (the ids of the protected areas the live scan found; --owner-go passes it, always): the record must carry exactly the digest of the Areas block
// the owner was shown for them (areasDigest). A record without the field (shown before Areas lines, or none shown) means "no areas": it still approves a
// diff without areas, exactly as before, and never one with areas. `areas: null` (only the gated route, bound by the gate's ownerItems) says "this route does
// not bind areas" and compares nothing; `undefined` (a caller that forgot) compares as no areas, so it fails closed.
// `hold` (rev 4 items 2a, 5; the same rule for the needs-human hold): `{ id, login, at }`, the LIVE hold P merge read from the PR timeline (null: no hold); the record must name exactly
// that hold id AND carry the digest of the Hold block the owner was shown (holdDigest), compared both ways: an old record without them (shown before Hold lines) never lifts a hold, a
// record for hold X never covers hold Y, a record with a hold never approves a PR that has none now. `hold: null` (only the gated route, which lifts no hold) compares nothing;
// `undefined` (absent, a caller that forgot) means "no hold" and fails closed.
const approvalsFor = ({ repo, pr, head, items, areas, hold, ...opts }) => {
  const key = repoKey(repo);
  if (key === null || !/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return [];
  const wantAreas = areas === null ? null : areasDigest(areas);
  const wantHold = hold === null ? null : { id: hold ? hold.id : 'none', digest: holdDigest(hold) }; // (undefined = no hold)
  return readApprovals(opts).filter((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items
    && (wantAreas === null || (typeof q.areas === 'string' ? q.areas : 'none') === wantAreas)
    && (wantHold === null || ((typeof q.hold === 'string' ? q.hold : 'none') === wantHold.id && (typeof q.holdBlock === 'string' ? q.holdBlock : 'none') === wantHold.digest))));
};
export function approvalGap(q) {
  const matching = approvalsFor(q);
  if (matching.length === 0) return 'none';
  return ownedBy(matching, { home: q.home }).length > 0 ? 'ok' : 'provenance';
}
export const approvedRequest = (q) => approvalGap(q) === 'ok';

// R2-F3 (fix round): promptProvenance trusts a transcript only under a `.claude*` folder directly under the account's home (isTranscriptFile; $CLAUDE_CONFIG_DIR names no root: it is the agent's
// word). So a genuine record refused for "missing" may only mean the owner's Claude Code config dir is somewhere else. That is likely when the record's transcript has the shape of a session
// transcript (<dir>/projects/<project>/<session>.jsonl) yet is under no such folder; a record whose transcript is simply gone, or is no transcript at all, gets no hint. The hint says what is
// required (it cannot be satisfied by setting the variable). Returns text to append to the refusal ('' when it does not apply).
export const CONFIG_DIR_HINT = 'the transcript of that prompt is not under a Claude Code config dir this check trusts: only a .claude* folder directly under the account\'s home (~/.claude, ~/.claude-work) counts, and CLAUDE_CONFIG_DIR is not consulted, so a config dir anywhere else cannot confirm the owner\'s words; move the owner\'s config dir to a .claude* folder directly under the home';
const TRANSCRIPT_SHAPE = /[\\/]projects[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/;
export function configDirHint(records, { home = accountHome() } = {}) {
  const plausible = (r) => {
    const file = r?.transcript_path;
    return typeof file === 'string' && path.isAbsolute(file) && TRANSCRIPT_SHAPE.test(file) && !/(?:^|[\\/])subagents[\\/]/.test(file) && !isTranscriptFile(file, { home });
  };
  return (records ?? []).some(plausible) ? CONFIG_DIR_HINT : '';
}
export const approvalConfigDirHint = (q) => configDirHint(approvalsFor(q), { home: q.home });
export const rulingConfigDirHint = (q) => configDirHint(rulingsFor(q), { home: q.home });

// The guard, before a direct merge: did the owner say "merge" in this session (last 24 h) for a request about this repository and PR
// whose head is this full head? (A PR merely named in the prompt, `merge #7`, is recorded in `prs` for the audit trail but approves no head.)
export function approvedPr({ repo, pr, head, session, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(String(head)) || !SESSION_RE.test(String(session ?? ''))) return false;
  return ownedBy(readApprovals({ ...opts, session }).filter((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head))), { home: opts.home }).length > 0;
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
  return typeof contentOf === 'function' && ownedBy(rulingsFor(q), { home: q.home }).some((r) => typeof r.content === 'string' && r.content === contentOf(r.ids));
}

// Why ownerRuled said no, for the message: 'none' (no such answer recorded), 'provenance' (answers exist but none is confirmed as typed by
// the owner: checked first), 'no-content' (every one is in the old line shape) or 'changed' (the finding text differs from the one the owner
// was asked about).
export function ownerRulingGap(q) {
  const found = rulingsFor(q);
  if (found.length === 0) return 'none';
  const owned = ownedBy(found, { home: q.home });
  if (owned.length === 0) return 'provenance';
  return owned.every((r) => typeof r.content !== 'string') ? 'no-content' : 'changed';
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}

// ---- Owner-granted extra review round ---------------------------------------------------------------------------------------------
// cp #104 caps counted review rounds at review.max_rounds (+ one automatic extra round). The owner can grant ONE more by typing
// `extra round` in chat after a reply that ENDS with the line `P triage round-request` prints:
//   `🔁 Extra review round needed #N: round <k> · head <sha12> · repo <owner/name>`   (k = the counted ordinal; reviewed + 1)
// The recorder (same hook, same folder) stores the owner's words verbatim as a kind 'extra-round' record bound to that repository, PR, k
// and head. codex-review then needs such a record (< 24 h) for the head under review, and consumes it AFTER Codex ran by exclusively
// creating a machine-global marker `consumed/<grantId>.json` (claimGrantMarkers): one grant admits one run, wherever the checkout is. The
// final gate recomputes the grant from record + marker (verifyOwnerGrant), so a forged `ownerGrant` in review state proves nothing.
// #128: the grant is as strict as a "merge": a harness-injected turn is never recorded (notOwnerWords), and a record counts only while its prompt
// is still the owner's in the transcript (promptProvenance, ownedBy) — at the cap lookup (ownerGrantedRounds) and at the final gate (verifyOwnerGrant).
// Residual: as for "merge" and rulings (see the top of this file), plus a nested `claude -p --resume` the guards do not name (cp issue).
const ROUND_LINE = new RegExp(`^\\s*(?:🔁)?\\s*Extra review round needed\\s+#(\\d{1,6})\\s*:\\s*round\\s+(\\d{1,3})\\s*(?:·|\\|)\\s*head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME})\\s*$`, 'i');
export const ROUND_GRANT_PROMPT_MAX = 300; // a grant is a few words; a longer prompt is not one and is not recorded (never cut)

// The extra-round request a reply ENDS with (its last non-blank line). Returns { pr, k, head (lower case, 12..40), repo (lower case) } or null.
export function presentedRoundRequest(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const m = ROUND_LINE.exec(lines[lines.length - 1] ?? '');
  if (!m) return null;
  return { pr: Number(m[1]), k: Number(m[2]), head: m[3].toLowerCase(), repo: m[4].toLowerCase() };
}

// A prompt that grants: "extra round", "grant round 4 #1544", "extra review round, please". Same strictness as parseApproval: the words
// after the opener are targets (#N = a PR, a bare integer = the PR or the round, resolved against the request line by the recorder) and
// filler only; "extra round?", "no extra round", "grant round 4 after CI", "why extra round" grant nothing. Returns null or { prs, numbers }.
export function parseRoundGrant(prompt) {
  const t = String(prompt ?? '').trim();
  const m = /^(?:extra|grant)\s+(?:review\s+)?round(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes('?')) return null;
  const prs = [];
  const numbers = [];
  for (const tok of rest.replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if ((x = /^(\d{1,6})$/.exec(tok))) numbers.push(Number(x[1]));
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], numbers: [...new Set(numbers)] };
}

// The extra-round recorder (same hook, same folder): when the reply right before the owner's prompt ends with the request line, writes the
// prompt verbatim, bound to that repository, PR, counted round and head. A PR or round the prompt names must be the line's; anything else
// records nothing. Returns the record, or null. Never throws.
export function recordRoundGrant(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session) || typeof input?.prompt !== 'string' || input.prompt.trim() === '' || input.prompt.length > ROUND_GRANT_PROMPT_MAX) return null;
    const g = parseRoundGrant(input.prompt);
    if (!g) return null;
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: strict like a "merge" — a notice, a peer's or a scheduled turn's "extra round")
    const asked = presentedRoundRequest(lastReplyText(String(input?.transcript_path ?? ''), { prompt: input.prompt }));
    if (!asked) return null;
    if (!g.prs.every((n) => n === asked.pr) || !g.numbers.every((n) => n === asked.pr || n === asked.k)) return null;
    return appendRecord(home, session, {
      v: 1, kind: 'extra-round', ts: new Date(now()).toISOString(), session,
      prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      repo: asked.repo, pr: asked.pr, k: asked.k, head: asked.head, ...promptRefs(input), prompt: input.prompt,
    });
  } catch {
    return null;
  }
}

const FULL_HEAD = /^[0-9a-f]{40}$/;
// Is this a well-formed extra-round record (the hook's own shape)? A hand-edited prompt no longer hashes to prompt_sha256.
function isRoundRecord(r) {
  return r?.kind === 'extra-round' && typeof r.session === 'string' && typeof r.ts === 'string' && typeof r.prompt_sha256 === 'string'
    && repoKey(r.repo) === r.repo && Number.isInteger(r.pr) && Number.isInteger(r.k) && /^[0-9a-f]{12,40}$/.test(String(r.head))
    && typeof r.prompt === 'string' && r.prompt.trim() !== '' && r.prompt.length <= ROUND_GRANT_PROMPT_MAX
    && createHash('sha256').update(r.prompt).digest('hex') === r.prompt_sha256;
}

// The id a grant's marker is named by: the record's session, time and prompt hash (16 hex); null for a record without them.
export function grantIdOf(record) {
  if (typeof record?.session !== 'string' || typeof record.ts !== 'string' || typeof record.prompt_sha256 !== 'string') return null;
  return createHash('sha256').update(`${record.session}|${record.ts}|${record.prompt_sha256}`).digest('hex').slice(0, 16);
}

const CONSUMED_REL = `${OWNER_GO_REL}/consumed`;
const GRANT_ID = /^[0-9a-f]{16}$/;
export const markerPath = (grantId, { home = accountHome() } = {}) => (GRANT_ID.test(String(grantId)) ? path.join(home, ...CONSUMED_REL.split('/'), `${grantId}.json`) : null);

// 'ok' (every folder from <home>/.claude down is a real directory), 'missing' (one is absent) or 'unsafe' (a link, a file, unreadable).
function chainState(home, rel) {
  let p = home;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return 'unsafe';
    } catch (err) {
      return err?.code === 'ENOENT' ? 'missing' : 'unsafe';
    }
  }
  return 'ok';
}

// The unspent records (before the provenance check) for this repository, PR, counted round k, newest first (see ownerGrantedRounds).
function grantsFor({ repo, pr, k, head, anyHead = false, ...opts } = {}) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !Number.isInteger(k) || (!anyHead && !FULL_HEAD.test(String(head)))) return [];
  return readRecords(opts)
    .filter((r) => isRoundRecord(r) && r.repo === key && r.pr === pr && r.k === k && r.head.length >= HEAD_CHARS && (anyHead || head.startsWith(r.head))
      && !readGrantMarker(grantIdOf(r), { home: opts.home }).spent)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// Every record for this repository, PR, counted round k whose recorded head starts the full head under review, younger than 24 h, with NO
// marker (a consumed, partial or unreadable marker is spent), newest first. All of them: a duplicate "extra round" must not outlive a claim.
// anyHead: true drops the head test (head is then ignored): the caller compares the head itself, to tell a stale grant from none.
// #128: only a record whose prompt is the owner's (promptProvenance) counts, as for a "merge".
export const ownerGrantedRounds = (q = {}) => ownedBy(grantsFor(q), { grant: true, home: q.home });

// Why ownerGrantedRounds found nothing, for the message: 'none' (no such record), 'provenance' (records exist but none is confirmed as typed
// by the owner) or 'ok' (at least one is the owner's).
export function ownerGrantGap(q = {}) {
  const found = grantsFor(q);
  if (found.length === 0) return 'none';
  return ownedBy(found, { grant: true, home: q.home }).length > 0 ? 'ok' : 'provenance';
}

// R2-F3 for a grant: text to append to a refusal when the unconfirmed records' transcripts are under a config dir this process does not know ('' otherwise).
export const ownerGrantConfigDirHint = (q = {}) => configDirHint(grantsFor(q), { home: q.home });

// Consumes the grants: exclusively creates one marker per record (sorted by id, so two claimers meet on the same first marker). body =
// { repo, pr, k, head (40 hex), checkout }; each marker holds { v:1, grantId, repo, pr, k, head, consumedAt, checkout }. The file is written
// and fsynced (the folder too, except on Windows), and any error after the marker exists leaves it SPENT. Returns { ok:true, claimed:[{ grantId,
// file }] } or { ok:false, reason: 'used' (a marker was there) | 'spent' (we created it, then failed) | 'unsafe' | 'invalid' | 'none' }.
// `io` replaces writeSync / fsyncSync (tests).
export function claimGrantMarkers(records, body, { home = accountHome(), now = Date.now, io = {} } = {}) {
  const ids = [...new Set((records ?? []).map(grantIdOf))];
  if ((records ?? []).length === 0) return { ok: false, reason: 'none' };
  const key = repoKey(body?.repo);
  if (ids.includes(null) || key === null || !Number.isInteger(body?.pr) || !Number.isInteger(body?.k) || !FULL_HEAD.test(String(body?.head))) return { ok: false, reason: 'invalid' };
  if (!realDirChain(home, CONSUMED_REL)) return { ok: false, reason: 'unsafe' };
  const write = io.writeSync ?? writeSync;
  const sync = io.fsyncSync ?? fsyncSync;
  const claimed = [];
  for (const grantId of ids.sort()) {
    const file = markerPath(grantId, { home });
    let fd;
    try {
      fd = openSync(file, OPEN_EXCL, 0o600);
    } catch (err) {
      return { ok: false, reason: err?.code === 'EEXIST' ? 'used' : 'unsafe', grantId, claimed };
    }
    try {
      write(fd, `${JSON.stringify({ v: 1, grantId, repo: key, pr: body.pr, k: body.k, head: body.head, consumedAt: new Date(now()).toISOString(), checkout: typeof body.checkout === 'string' ? body.checkout : null })}\n`);
      sync(fd);
    } catch {
      try { closeSync(fd); } catch { /* spent either way */ }
      return { ok: false, reason: 'spent', grantId, claimed };
    }
    try { closeSync(fd); } catch { return { ok: false, reason: 'spent', grantId, claimed }; }
    claimed.push({ grantId, file });
  }
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(path.dirname(markerPath(ids[0], { home })), constants.O_RDONLY);
      try { sync(dfd); } finally { closeSync(dfd); }
    } catch {
      return { ok: false, reason: 'spent', claimed };
    }
  }
  return { ok: true, claimed };
}

// What is on disk for a grant id: { spent: false, verifiable: false } (no marker), { spent: true, verifiable: true, marker } or
// { spent: true, verifiable: false } (a partial, unparseable, linked or otherwise odd marker, or an unsafe folder: spent, never trusted).
export function readGrantMarker(grantId, { home = accountHome() } = {}) {
  const file = markerPath(grantId, { home });
  if (file === null) return { spent: true, verifiable: false };
  const chain = chainState(home, CONSUMED_REL);
  if (chain === 'missing') return { spent: false, verifiable: false };
  if (chain === 'unsafe') return { spent: true, verifiable: false };
  try {
    if (!lstatSync(file).isFile()) return { spent: true, verifiable: false };
  } catch (err) {
    return err?.code === 'ENOENT' ? { spent: false, verifiable: false } : { spent: true, verifiable: false };
  }
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 64 * 1024) return { spent: true, verifiable: false };
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const m = JSON.parse(text);
    if (m?.v === 1 && m.grantId === grantId && repoKey(m.repo) === m.repo && Number.isInteger(m.pr) && Number.isInteger(m.k) && FULL_HEAD.test(String(m.head)) && typeof m.consumedAt === 'string') {
      return { spent: true, verifiable: true, marker: m };
    }
  } catch { /* partial or unreadable: spent, not verifiable */ }
  return { spent: true, verifiable: false };
}

const VERIFY_MAX_BYTES = 64 * 1024 * 1024; // the gate's read of the records: a big session file must not hide one

// The final gate / review-complete: is `ownerGrant` ({ grantId, quote, k? }) on a counted round k of this repository's PR, whose head under
// review is `toHead` (full), backed by an owner record (read at any age) AND a verifiable marker? The grant id is recomputed from the
// record, repo / PR / k must equal, the marker's full head must be `toHead`, and the quote must be the record's prompt byte for byte.
// Returns { ok: true, quote, record } or { ok: false, reason }.
export function verifyOwnerGrant({ repo, pr, k, toHead, ownerGrant } = {}, opts = {}) {
  const key = repoKey(repo);
  const id = ownerGrant?.grantId;
  if (key === null || !Number.isInteger(pr) || !Number.isInteger(k) || !FULL_HEAD.test(String(toHead))) return { ok: false, reason: 'malformed' };
  if (!GRANT_ID.test(String(id)) || typeof ownerGrant.quote !== 'string' || (ownerGrant.k !== undefined && ownerGrant.k !== k)) return { ok: false, reason: 'malformed' };
  const record = readRecords({ ...opts, maxAgeMs: Infinity, maxBytes: VERIFY_MAX_BYTES }).find((r) => isRoundRecord(r) && grantIdOf(r) === id);
  if (!record) return { ok: false, reason: 'no-record' };
  if (record.repo !== key || record.pr !== pr || record.k !== k || !toHead.startsWith(record.head)) return { ok: false, reason: 'mismatch' };
  if (ownedBy([record], { grant: true, home: opts.home }).length === 0) return { ok: false, reason: 'provenance' }; // (#128: the prompt is not the owner's, or is gone from the transcript)
  const m = readGrantMarker(id, { home: opts.home });
  if (!m.spent) return { ok: false, reason: 'no-marker' };
  if (!m.verifiable) return { ok: false, reason: 'unverifiable-marker' };
  if (m.marker.repo !== key || m.marker.pr !== pr || m.marker.k !== k || m.marker.head !== toHead) return { ok: false, reason: 'mismatch' };
  if (ownerGrant.quote !== record.prompt) return { ok: false, reason: 'quote' };
  return { ok: true, quote: record.prompt, record };
}
