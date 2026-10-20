// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which only a real prompt typed by the owner reaches) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval).
// `P merge` then needs a record for exactly that PR, head and owner-item set; the guard needs one (for that PR, in that
// session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. guard-files keeps
// agents from writing the folder or running the recorder.
// Chat mode without the needs-human label (docs/plans/2026-10-20-chat-mode-no-needs-human.md): a stop for the owner is an owner-stop
// event with an id; the controller's reply ends with `Stopped #N · stop <id>` and the owner's typed `ship resume N` (or `merge`, when
// the reply offered it) is recorded here as a RELEASE for exactly that PR and id. `P checkpoint --resumed` posts the release event only
// with such a record, and `P merge` demands an owner "merge" that was given to a request carrying the PR's newest stop id.
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

// A prompt that releases an owner stop: "ship resume 12", "resume #12", "Resume 12 please", "/ship resume 12", "/resume 12". The PR number
// is required. "resume?", "do not resume", "resume later", "resume" alone: not. Returns null or { prs }.
export function parseResume(prompt) {
  const t = String(prompt ?? '').trim();
  const m = /^\/?(?:ship\s+)?resume(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m) return null;
  if (m[1].includes('?')) return null;
  const prs = [];
  for (const tok of m[1].replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    const x = /^#?(\d{1,6})$/.exec(tok);
    if (x) prs.push(Number(x[1]));
    else if (!FILLER.test(tok)) return null;
  }
  return prs.length ? { prs: [...new Set(prs)] } : null;
}

// The merge request a reply ENDS with. The reply's last lines are the request (skills/ship): optional `Head <sha12> · items <digest>`
// lines (or, for several PRs, `#N head <sha12> · items <digest>`) directly above the 🔀 line, which is the last non-blank line.
// Only that terminal block binds: an earlier block in the same reply, a Head line with prose between it and the 🔀 line, or any
// text after the 🔀 line binds nothing, and a PR bound twice (two heads, or the same line twice) is ambiguous, so it binds nothing.
// Returns { prs: [N…] (every PR on the 🔀 line; [] when the reply does not end with it), requests: [{ pr, head, items }] }.
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
const WAIT_LINE = /⏸\s*Waiting on you for\s+([^\n]*)/;
export const STOP_LINE = /^\s*Stopped\s+#(\d+)\s*(?:·|\|)\s*stop\s+([0-9a-f]{8})\s*$/i;
const prsOnLine = (rest) => [...new Set([...rest.split(/—|\s--?\s|\bsay\b/)[0].matchAll(/#(\d{1,6})\b/g)].map((x) => Number(x[1])))];
const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)\\s*$`, 'i');
// A `Stopped #N · stop <id>` line may sit in the same contiguous block (above or among the Head lines), and a `⏸ Waiting on you for #N` last line
// ends a reply that asks for a resume instead of a merge (`presentedStops`).
function terminalBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const last = lines[lines.length - 1] ?? '';
  const ready = READY_LINE.exec(last);
  const wait = ready ? null : WAIT_LINE.exec(last);
  const end = ready ?? wait;
  if (!end) return null;
  const prs = prsOnLine(end[1]);
  const heads = [];
  const stopLines = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const h = HEAD_LINE.exec(lines[i]);
    const s = STOP_LINE.exec(lines[i]);
    if (!h && !s) break;
    if (h) heads.unshift(h);
    else stopLines.unshift({ pr: Number(s[1]), stop: s[2].toLowerCase() });
  }
  const seen = new Set();
  const stops = stopLines.filter((s) => prs.includes(s.pr) && !seen.has(`${s.pr}/${s.stop}`) && seen.add(`${s.pr}/${s.stop}`));
  return { ending: ready ? 'merge' : 'wait', prs, heads, stops };
}

export function presentedRequests(text) {
  const b = terminalBlock(text);
  if (!b || b.ending !== 'merge') return { prs: [], requests: [] };
  const { prs } = b;
  const bound = new Map();
  for (const h of b.heads) {
    const pr = h[1] ? Number(h[1]) : prs.length === 1 ? prs[0] : null;
    if (pr === null || !prs.includes(pr)) continue;
    bound.set(pr, bound.has(pr) ? null : { pr, head: h[2].toLowerCase(), items: h[3].toLowerCase() });
  }
  const requests = [...bound.values()].filter(Boolean).map((q) => {
    const ids = b.stops.filter((s) => s.pr === q.pr).map((s) => s.stop);
    return ids.length ? { ...q, stops: ids } : q;
  });
  return { prs, requests };
}

// What the reply's terminal block says about owner stops: { ending: 'merge' (the 🔀 line) | 'wait' (the ⏸ line) | null, prs: the PRs on that last line,
// stops: [{ pr, stop }] one per distinct `Stopped` line of the block for a PR on the last line }.
export function presentedStops(text) {
  const b = terminalBlock(text);
  return b ? { ending: b.ending, prs: b.prs, stops: b.stops } : { ending: null, prs: [], stops: [] };
}

// The text of the last assistant reply in the transcript when it holds a 🔀 merge request ('' when none). Only the
// transcript's last 4 MB are read. A reply is every assistant text block between two prompts.
// `prompt` is the text being submitted (the UserPromptSubmit hook's input.prompt). Why (#58 round 3): the hook may run before or after the
// transcript gets that prompt, so the newest prompt entry is "the current one" (its empty slot skipped) only when its text IS that prompt;
// any other newest prompt is an older, unanswered one, and the empty reply slot after it is the reply to use: no request, the one before is stale.
// Without `prompt` the newest prompt entry is taken to be the current one.
export function lastRequestText(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES, prompt } = {}) {
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
  return READY_LINE.test(replies[last]) || WAIT_LINE.test(replies[last]) ? replies[last] : '';
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
export function realDirChain(home, rel) {
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
    const merge = parseApproval(input?.prompt);
    const resume = merge ? null : parseResume(input?.prompt);
    if (!merge && !resume) return null;
    const text = lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt) });
    const stops = presentedStops(text);
    let record;
    if (merge) {
      const a = merge;
      const shown = presentedRequests(text);
      const wanted = (pr) => a.prs.length === 0 || a.prs.includes(pr);
      const shaOk = (head) => a.shas.length === 0 || a.shas.some((s) => head.startsWith(s) || s.startsWith(head));
      const requests = shown.requests.filter((r) => wanted(r.pr) && shaOk(r.head));
      // PRs the owner approved for a direct merge: those the reply asked about (narrowed by the prompt), plus any the prompt names
      const prs = [...new Set([...shown.prs.filter(wanted), ...a.prs])];
      // "merge" releases the stops of a reply that offered a merge (its 🔀 last line), for the PRs the prompt allows
      // (the same head filter as the approval: "merge <sha>" naming a head the request does not show releases nothing for that PR)
      const releases = stops.ending === 'merge' ? stops.stops.filter((s) => wanted(s.pr) && (a.shas.length === 0 || requests.some((r) => r.pr === s.pr))) : [];
      record = { v: 1, kind: 'approve', ts: new Date(now()).toISOString(), session, prompt_sha256: createHash('sha256').update(String(input.prompt)).digest('hex'), cwd: typeof input.cwd === 'string' ? input.cwd : null, prs, requests, releases };
    } else {
      // "resume N" releases the stops of a reply that ended with either last line, for the PRs it names, and approves NO merge.
      const releases = stops.ending ? stops.stops.filter((s) => resume.prs.includes(s.pr)) : [];
      if (releases.length === 0) return null; // (a new session: no stop line before it; the controller shows the stop lines and asks once more)
      record = { v: 1, kind: 'resume', ts: new Date(now()).toISOString(), session, prompt_sha256: createHash('sha256').update(String(input.prompt)).digest('hex'), cwd: typeof input.cwd === 'string' ? input.cwd : null, prs: resume.prs, requests: [], releases };
    }
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
export function readApprovals({ home = accountHome(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
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
      // Only the two kinds the recorder writes: a record of any other kind approves nothing, and a "resume" record never carries a merge request.
      if (r.kind !== 'approve' && r.kind !== 'resume') continue;
      out.push({
        ts: r.ts,
        session: r.session,
        kind: r.kind, // ('approve' = the owner typed "merge"; releaseRef.kind says 'merge')
        prompt_sha256: typeof r.prompt_sha256 === 'string' ? r.prompt_sha256 : null,
        prs: Array.isArray(r.prs) ? r.prs.filter(Number.isInteger) : [],
        requests: r.kind === 'approve' && Array.isArray(r.requests) ? r.requests.filter((q) => Number.isInteger(q?.pr) && typeof q.head === 'string' && typeof q.items === 'string') : [],
        releases: Array.isArray(r.releases) ? r.releases.filter((x) => Number.isInteger(x?.pr) && /^[0-9a-f]{8}$/.test(String(x.stop))).map((x) => ({ pr: x.pr, stop: String(x.stop) })) : [],
      });
    }
  }
  return out;
}

// P merge: did the owner say "merge" for exactly this PR, this full head and this owner-item set (any session, last 24 h)?
// `stop` (an id, or a list of ids: the PR's newest owner-stop id and every open one, when it has ever had a stop): the request the owner answered must
// also have listed EVERY one of them on a `Stopped #N · stop <id>` line, so an approval given before the stop (its request carried no id) can never be replayed after it.
export function approvedRequest({ pr, head, items, stop = null, ...opts }) {
  if (!/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return false;
  const need = [...new Set([].concat(stop ?? []).map(String))];
  return readApprovals(opts).some((r) => r.requests.some((q) => q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items
    && need.every((id) => Array.isArray(q.stops) && q.stops.includes(id))));
}

// `P checkpoint --resumed`: did the owner release THIS stop of THIS PR (a typed `ship resume N`, or `merge` after a reply that offered it), any session,
// last 24 h? The newest matching record, or null. The id is minted at stop time and shown to the owner afterwards, so a release cannot predate its stop.
export function approvedRelease({ pr, stop, ...opts }) {
  if (!Number.isInteger(pr) || !/^[0-9a-f]{8}$/.test(String(stop))) return null;
  const hits = readApprovals(opts).filter((r) => r.releases.some((x) => x.pr === pr && x.stop === stop));
  return hits.sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts))[0] ?? null;
}

// The hook's one line of context for a recorded prompt (hooks/owner-go.mjs).
export function hookMessage(record) {
  const shown = record.requests.map((q) => `#${q.pr} head ${q.head} items ${q.items}`);
  const prs = record.prs.map((n) => `#${n}`).join(', ');
  const rel = (record.releases ?? []).map((x) => `#${x.pr} stop ${x.stop}`);
  if (record.kind === 'resume') return `[claude-pipeline owner-go] the owner's "resume" is recorded as a release of ${rel.join('; ')} (no merge approval): run P checkpoint --pr N --step gate --resumed to post it.\n`;
  const relText = rel.length ? `; releases ${rel.join('; ')}` : '';
  return `[claude-pipeline owner-go] the owner's "merge" is recorded: ${shown.length ? shown.join('; ') : 'no Head/items request was shown in the last merge request'}${prs ? `; PRs ${prs}` : ''}${relText}.\n`;
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}
