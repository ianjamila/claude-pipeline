// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which only a real prompt typed by the owner reaches) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval).
// `P merge` then needs a record for exactly that PR, head and owner-item set; the guard needs one (for that PR, in that
// session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. guard-files keeps
// agents from writing the folder or running the recorder.
// Plan approvals (ship redesign): the same recorder also writes down an owner prompt that STARTS with "approve", bound to what the
// reply right before it asked for: `Plan <blob40> · scope <digest12>` + `📋 Ready to approve plan #N — say "approve"`. Those lines
// carry `kind: 'plan'`; merge readers never see them. `P plan approve` accepts one for 24 h after it was issued (that window is
// checked there), but the record stays readable for 30 days so an interrupted run can repair from it.
// A plan record also carries `repo` ("owner/name" from the hook cwd's `origin`) when it can be derived, so the same PR number and a
// byte-identical plan blob in ANOTHER repo cannot reuse the approval (matching treats a differing repo as no match). RESIDUAL: a record
// without `repo` (written before this field, or in a session that started outside a repo / without an origin) still matches on
// pr + blob + scope digest alone.
// Residual (owner ruling 2026-10-14, the "cheap step"): the agent runs as the same OS user, so a program the guards cannot
// see into can still write the folder; the transcript the recorder reads is a file of that user; and the agent's GitHub
// token is the owner's. A second GitHub identity + a ruleset is the server-side backstop (issue #65).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const OWNER_GO_REL = '.claude/pipeline-state/owner-go';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a "merge" older than a day approves nothing
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024; // one session file; a bigger one is not read
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const PLAN_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // plan records stay readable for 30 days
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

// Same text as pipeline/lib/plan.mjs (a parity test keeps them equal; this file must not import lib/).
export const PLAN_LINE_RE = /^\s*Plan\s+([0-9a-f]{40})\s*(?:·|\|)\s*scope\s+([0-9a-f]{12})\s*$/;
export const PLAN_READY_RE = /📋\s*Ready to approve plan\s+#(\d{1,6})\b/;

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

// "approve", "approved", "approve #58", "approve <blob prefix ≥7>", with the merge fillers. Anything else is not an approval.
// Returns null or { prs, blobs }.
export function parsePlanApproval(prompt) {
  const t = String(prompt ?? '').trim();
  const m = /^approved?(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m || m[1].includes('?')) return null;
  const prs = [];
  const blobs = [];
  for (const tok of m[1].replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#?(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if (/^[0-9a-f]{7,40}$/i.test(tok)) blobs.push(tok.toLowerCase());
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], blobs: [...new Set(blobs)] };
}

// The merge request a reply ENDS with. The reply's last lines are the request (skills/ship): optional `Head <sha12> · items <digest>`
// lines (or, for several PRs, `#N head <sha12> · items <digest>`) directly above the 🔀 line, which is the last non-blank line.
// Only that terminal block binds: an earlier block in the same reply, a Head line with prose between it and the 🔀 line, or any
// text after the 🔀 line binds nothing, and a PR bound twice (two heads, or the same line twice) is ambiguous, so it binds nothing.
// Returns { prs: [N…] (every PR on the 🔀 line; [] when the reply does not end with it), requests: [{ pr, head, items }] }.
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
// The plan request a reply ENDS with: the last non-blank line is the 📋 line and the line right above it the Plan line.
// Ambiguous replies record nothing (spec §2a): any other Plan / 📋 line anywhere in the reply, or any 🔀 merge line.
export function presentedPlanRequest(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ready = PLAN_READY_RE.exec(lines.at(-1) ?? '');
  const plan = PLAN_LINE_RE.exec(lines.at(-2) ?? '');
  if (!ready || !plan) return null;
  const count = (re) => lines.filter((l) => re.test(l)).length;
  if (count(PLAN_LINE_RE) !== 1 || count(PLAN_READY_RE) !== 1 || count(READY_LINE) !== 0) return null;
  return { pr: Number(ready[1]), blob: plan[1], scopeDigest: plan[2] };
}

const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)\\s*$`, 'i');
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
    bound.set(pr, bound.has(pr) ? null : { pr, head: h[2].toLowerCase(), items: h[3].toLowerCase() });
  }
  return { prs, requests: [...bound.values()].filter(Boolean) };
}

// The text of the last assistant reply in the transcript when it holds a request line ('' when none): the 🔀 merge marker by default,
// or the marker passed as `ready` (the plan path passes PLAN_READY_RE). Only the
// transcript's last 4 MB are read. A reply is every assistant text block between two prompts.
// `prompt` is the text being submitted (the UserPromptSubmit hook's input.prompt). Why (#58 round 3): the hook may run before or after the
// transcript gets that prompt, so the newest prompt entry is "the current one" (its empty slot skipped) only when its text IS that prompt;
// any other newest prompt is an older, unanswered one, and the empty reply slot after it is the reply to use: no request, the one before is stale.
// Without `prompt` the newest prompt entry is taken to be the current one.
export function lastRequestText(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES, prompt, ready = READY_LINE } = {}) {
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
  return ready.test(replies[last]) ? replies[last] : '';
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

// "owner/name" from the origin URL of the repo that holds `cwd` (any subdirectory or worktree gives the same one), or null. Never
// throws and is time-boxed: a hook must not hang on git. Accepts https / ssh / scp-like URLs, with or without `.git`.
export function repoFromCwd(cwd) {
  try {
    if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) return null;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    const r = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000, env, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) return null;
    const m = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/.exec(r.stdout.trim());
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

// The recorder. Writes one line to <home>/.claude/pipeline-state/owner-go/<session>.jsonl for an owner prompt that approves;
// returns the record, or null (not an approval, a subagent, no session, or the write failed). Never throws.
export function recordApproval(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session)) return null;
    const base = {
      v: 1,
      ts: new Date(now()).toISOString(),
      session,
      prompt_sha256: createHash('sha256').update(String(input?.prompt)).digest('hex'),
      cwd: typeof input?.cwd === 'string' ? input.cwd : null,
    };
    const a = parseApproval(input?.prompt);
    let record;
    if (a) {
      const shown = presentedRequests(lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt) }));
      const wanted = (pr) => a.prs.length === 0 || a.prs.includes(pr);
      const shaOk = (head) => a.shas.length === 0 || a.shas.some((s) => head.startsWith(s) || s.startsWith(head));
      const requests = shown.requests.filter((r) => wanted(r.pr) && shaOk(r.head));
      // PRs the owner approved for a direct merge: those the reply asked about (narrowed by the prompt), plus any the prompt names
      const prs = [...new Set([...shown.prs.filter(wanted), ...a.prs])];
      record = { ...base, prs, requests }; // no `kind`: merge lines are unchanged; readers treat a missing kind as a merge record
    } else {
      const pa = parsePlanApproval(input?.prompt);
      if (!pa) return null;
      const shown = presentedPlanRequest(lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt), ready: PLAN_READY_RE }));
      if (!shown) return null;
      if (pa.prs.length && !pa.prs.includes(shown.pr)) return null;
      if (pa.blobs.length && !pa.blobs.some((b) => shown.blob.startsWith(b))) return null;
      const repo = repoFromCwd(base.cwd);
      record = { ...base, kind: 'plan', record_id: randomBytes(8).toString('hex'), ...(repo ? { repo } : {}), prs: [], requests: [], plan: shown };
    }
    return appendRecord(home, session, record) ? record : null;
  } catch {
    return null;
  }
}

// Appends one record line to <home>/.claude/pipeline-state/owner-go/<session>.jsonl through real folders and files only.
function appendRecord(home, session, record) {
  if (!realDirChain(home, OWNER_GO_REL)) return false;
  const file = path.join(ownerGoDir(home), `${session}.jsonl`);
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
  }
  const fd = openSync(file, OPEN_APPEND, 0o600);
  try {
    if (!fstatSync(fd).isFile()) return false;
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Every parsed line (v 1, in its own session's file, not from the future, younger than maxAgeMs), from one session's file or
// (session null) from all of them. Never throws.
function readRecordLines({ home, session, now, maxAgeMs }) {
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

// The merge approvals: plan records (kind 'plan') are never merge approvals and are skipped.
export function readApprovals({ home = accountHome(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  const out = [];
  for (const r of readRecordLines({ home, session, now, maxAgeMs })) {
    if (r.kind === 'plan') continue;
    out.push({
      ts: r.ts,
      session: r.session,
      prs: Array.isArray(r.prs) ? r.prs.filter(Number.isInteger) : [],
      requests: Array.isArray(r.requests) ? r.requests.filter((q) => Number.isInteger(q?.pr) && typeof q.head === 'string' && typeof q.items === 'string') : [],
    });
  }
  return out;
}

// The plan approvals ("approve" records), valid for 30 days. `P plan approve` applies the 24 h issuance window itself.
export function readPlanApprovals({ home = accountHome(), session = null, now = Date.now, maxAgeMs = PLAN_RECORD_MAX_AGE_MS } = {}) {
  const out = [];
  for (const r of readRecordLines({ home, session, now, maxAgeMs })) {
    const p = r.kind === 'plan' ? r.plan : null;
    if (!Number.isInteger(p?.pr) || !/^[0-9a-f]{40}$/.test(String(p.blob)) || !/^[0-9a-f]{12}$/.test(String(p.scopeDigest))) continue;
    if (!/^[0-9a-f]{16}$/.test(String(r.record_id))) continue;
    out.push({ ts: r.ts, session: r.session, recordId: r.record_id, promptSha256: r.prompt_sha256, repo: typeof r.repo === 'string' && r.repo !== '' ? r.repo : null, pr: p.pr, blob: p.blob, scopeDigest: p.scopeDigest });
  }
  return out;
}

// P merge: did the owner say "merge" for exactly this PR, this full head and this owner-item set (any session, last 24 h)?
export function approvedRequest({ pr, head, items, ...opts }) {
  if (!/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return false;
  return readApprovals(opts).some((r) => r.requests.some((q) => q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items));
}

// The guard, before a direct merge: did the owner say "merge" in this session (last 24 h) for a request about this PR whose head
// is this full head? (A PR merely named in the prompt, `merge #7`, is recorded in `prs` for the audit trail but approves no head.)
export function approvedPr({ pr, head, session, ...opts }) {
  if (!Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(String(head)) || !SESSION_RE.test(String(session ?? ''))) return false;
  return readApprovals({ ...opts, session }).some((r) => r.requests.some((q) => q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head)));
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}
