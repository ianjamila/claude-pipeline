// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which only a real prompt typed by the owner reaches) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval).
// `P merge` then needs a record for exactly that PR, head and owner-item set; the guard needs one (for that PR, in that
// session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. guard-files keeps
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

export const ownerGoDir = (home = os.homedir()) => path.join(home, ...OWNER_GO_REL.split('/'));

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

// The merge requests one reply showed. The 🔀 line names the PRs; each `Head <sha12> · items <digest>` line (or, for several
// PRs, `#N head <sha12> · items <digest>`) binds a PR to the head and owner-item set the owner was shown. Returns
// { prs: [N…] (every PR on the 🔀 line), requests: [{ pr, head, items }] }.
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)\\s*$`, 'i');
export function presentedRequests(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let prs = [];
  for (const line of lines) {
    const r = READY_LINE.exec(line);
    if (r) prs = [...new Set([...r[1].split(/—|\s--?\s|\bsay\b/)[0].matchAll(/#(\d{1,6})\b/g)].map((x) => Number(x[1])))];
  }
  const requests = [];
  for (const line of lines) {
    const h = HEAD_LINE.exec(line);
    if (!h) continue;
    const pr = h[1] ? Number(h[1]) : prs.length === 1 ? prs[0] : null;
    if (pr === null || !prs.includes(pr)) continue;
    requests.push({ pr, head: h[2].toLowerCase(), items: h[3].toLowerCase() });
  }
  return { prs, requests };
}

// The text of the most recent assistant reply in the transcript that holds a 🔀 merge request ('' when none). Only the
// transcript's last 4 MB are read. A reply is every assistant text block between two prompts.
export function lastRequestText(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
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
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type === 'user') {
      const prompt = typeof content === 'string' || (Array.isArray(content) && content.some((b) => b?.type === 'text') && !content.some((b) => b?.type === 'tool_result'));
      if (prompt) replies.push('');
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') replies[replies.length - 1] += `${b.text}\n`;
    }
  }
  for (let i = replies.length - 1; i >= 0; i--) if (READY_LINE.test(replies[i])) return replies[i];
  return '';
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
export function recordApproval(input, { home = os.homedir(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session)) return null;
    const a = parseApproval(input?.prompt);
    if (!a) return null;
    const shown = presentedRequests(lastRequestText(String(input?.transcript_path ?? '')));
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
  } catch {
    return null;
  }
}

// Every valid record younger than maxAgeMs, from one session's file or (session null) from all of them. Never throws.
export function readApprovals({ home = os.homedir(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
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
      out.push({
        ts: r.ts,
        session: r.session,
        prs: Array.isArray(r.prs) ? r.prs.filter(Number.isInteger) : [],
        requests: Array.isArray(r.requests) ? r.requests.filter((q) => Number.isInteger(q?.pr) && typeof q.head === 'string' && typeof q.items === 'string') : [],
      });
    }
  }
  return out;
}

// P merge: did the owner say "merge" for exactly this PR, this full head and this owner-item set (any session, last 24 h)?
export function approvedRequest({ pr, head, items, ...opts }) {
  if (!/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return false;
  return readApprovals(opts).some((r) => r.requests.some((q) => q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items));
}

// The guard: did the owner say "merge" naming this PR (or for a request about it) in this session (last 24 h)?
export function approvedPr({ pr, session, ...opts }) {
  if (!Number.isInteger(pr) || !SESSION_RE.test(String(session ?? ''))) return false;
  return readApprovals({ ...opts, session }).some((r) => r.prs.includes(pr) || r.requests.some((q) => q.pr === pr));
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}
