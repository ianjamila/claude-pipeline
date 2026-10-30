// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which only a real prompt typed by the owner reaches) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest> · repo <owner/name>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval).
// `P merge` then needs a record for exactly that repository, PR, head and owner-item set; the guard needs one (for that repository and
// PR, in that session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. Phase 3b: the repository
// is part of the request, so a "merge" said for #N of one repository never approves #N of another (a fork, a mirror, a vendored copy
// that shares the commit). A request line without it approves nothing. guard-files keeps
// agents from writing the folder or running the recorder.
// Residual (owner ruling 2026-10-14, the "cheap step"): the agent runs as the same OS user, so a program the guards cannot
// see into can still write the folder; the transcript the recorder reads is a file of that user; and the agent's GitHub
// token is the owner's. A second GitHub identity + a ruleset is the server-side backstop (issue #65).
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNER_GO_REL = '.claude/pipeline-state/owner-go';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a "merge" older than a day approves nothing
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
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
export function lastReplyText(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES, prompt } = {}) {
  let raw = '';
  try {
    if (!lstatSync(transcriptPath).isFile()) return '';
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
    return '';
  }
  const replies = [''];
  let lastIsPrompt = false; // is the newest user/assistant entry a prompt (the owner's current one)?
  let lastPromptText = '';
  const plain = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type === 'user') {
      // (round 4: a user message is a prompt unless it carries a tool_result: an image-only message is one too, with no text)
      const isPrompt = typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result'));
      if (isPrompt) {
        replies.push('');
        lastPromptText = plain(typeof content === 'string' ? content : content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'));
      }
      lastIsPrompt = isPrompt;
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      lastIsPrompt = false;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') replies[replies.length - 1] += `${b.text}\n`;
    }
  }
  // Only the reply right before the owner's prompt: when the newest entry is that prompt, its own (empty) slot is skipped, and that is
  // the ONLY slot that may be. A later prompt plus a text-less assistant turn (tool calls only) leaves the old request stale, and an
  // older request is never revived by a later "merge": the agent shows it again.
  const current = lastIsPrompt && (prompt === undefined || plain(prompt) === lastPromptText);
  const last = replies.length - 1 - (current && replies.length > 1 ? 1 : 0);
  return replies[last] ?? '';
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
      prs,
      requests,
    };
    return appendRecord(home, session, record);
  } catch {
    return null;
  }
}

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
    const asked = presentedRuling(lastReplyText(String(input?.transcript_path ?? ''), { prompt: input.prompt }));
    if (!asked) return null;
    return appendRecord(home, session, {
      v: 1, kind: 'ruling', ts: new Date(now()).toISOString(), session,
      prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      repo: asked.repo, pr: asked.pr, ids: asked.ids, content: asked.content, prompt: input.prompt,
    });
  } catch {
    return null;
  }
}

// Every valid "merge" record younger than maxAgeMs, from one session's file or (session null) from all of them. Never throws.
export function readApprovals(opts = {}) {
  return readRecords(opts).filter((r) => r.kind === undefined).map((r) => ({
    ts: r.ts,
    session: r.session,
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

// P merge: did the owner say "merge" for exactly this repository (owner/name), PR, full head and owner-item set (any session, last 24 h)?
export function approvedRequest({ repo, pr, head, items, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return false;
  return readApprovals(opts).some((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items));
}

// The guard, before a direct merge: did the owner say "merge" in this session (last 24 h) for a request about this repository and PR
// whose head is this full head? (A PR merely named in the prompt, `merge #7`, is recorded in `prs` for the audit trail but approves no head.)
export function approvedPr({ repo, pr, head, session, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(String(head)) || !SESSION_RE.test(String(session ?? ''))) return false;
  return readApprovals({ ...opts, session }).some((r) => r.requests.some((q) => q.repo === key && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head)));
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
export function ownerRuled({ contentOf, ...q }) {
  return typeof contentOf === 'function' && rulingsFor(q).some((r) => typeof r.content === 'string' && r.content === contentOf(r.ids));
}

// Why ownerRuled said no, for the message: 'none' (no such answer recorded), 'no-content' (every one is in the old line shape) or
// 'changed' (the finding text differs from the one the owner was asked about).
export function ownerRulingGap(q) {
  const found = rulingsFor(q);
  if (found.length === 0) return 'none';
  return found.every((r) => typeof r.content !== 'string') ? 'no-content' : 'changed';
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}
