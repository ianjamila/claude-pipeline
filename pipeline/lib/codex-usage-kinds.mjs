// Where the Codex tokens went (plan 2026-11-11-codex-substitute-reviewer, "also worth considering"): the session logs under $CODEX_HOME/sessions, summed per kind
// of session, classified by the header of the prompt the pipeline writes (unknown => `other`). Ported from the owner's one-off script
// (claude-notes/plans/2026-11-11-codex-usage.mjs). Read only, bounded, and best effort: a file that does not parse is skipped. Display only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { codexHomeDir } from './codex-session.mjs';

export const KINDS = Object.freeze(['pipeline round 1', 'pipeline fix-check', 'pipeline second review', 'plan review', 'code review', 'other']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SINCE_DAYS = 7;

// The kind from the user's prompt text(s). The pipeline prompts say "independent second reviewer" (second review) or "independent reviewer of a pull request" with a
// "Review round: N" line (N = 1 the first review, later rounds the fix-check); a hand-run review names the plan or the changes.
export function kindOf(texts) {
  const t = (Array.isArray(texts) ? texts : [texts]).join('\n');
  if (/independent second reviewer/.test(t)) return 'pipeline second review';
  if (/You are an independent reviewer of a pull request/.test(t)) return /Review round: 1\b/.test(t) ? 'pipeline round 1' : 'pipeline fix-check';
  if (/plan review|review the plan|plan file|PLAN/i.test(t) && /review/i.test(t)) return 'plan review';
  if (/codex-review|review the (current|code) changes|reviewer/i.test(t)) return 'code review';
  return 'other';
}

function sessionOf(file) {
  let meta = null;
  let total = 0;
  const texts = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    if (j.type === 'session_meta') meta = j.payload;
    else if (j.type === 'response_item' && j.payload?.role === 'user') {
      for (const c of j.payload.content ?? []) if (c?.type === 'input_text' && typeof c.text === 'string' && !/^<(skills_instructions|permissions|collaboration_mode|environment_context)/.test(c.text)) texts.push(c.text.slice(0, 6000));
    } else if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
      const tt = j.payload.info?.total_token_usage?.total_tokens;
      if (Number.isFinite(tt) && tt > 0) total = tt;
    }
  }
  return meta ? { at: Date.parse(meta.timestamp), tokens: total, kind: kindOf(texts) } : null;
}

function* sessionFiles(root, sinceMs) {
  const dirs = (d) => { try { return readdirSync(d).filter((n) => /^\d+$/.test(n)).sort(); } catch { return []; } };
  const dayStart = new Date(sinceMs).toISOString().slice(0, 10).replaceAll('-', '/');
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    if (`${y}/${m}/${d}` < dayStart) continue;
    const dir = path.join(root, y, m, d);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) yield path.join(dir, n);
  }
}

// -> { since, sessions, totalTokens, byKind: { <kind>: { sessions, tokens } }, line }. `since`: ms or ISO; default 7 days before `now`.
export function summariseUsage({ env = process.env, now = Date.now(), since } = {}) {
  const parsed = since === undefined ? NaN : typeof since === 'number' ? since : Date.parse(since);
  const sinceMs = Number.isFinite(parsed) ? parsed : now - DEFAULT_SINCE_DAYS * 86_400_000;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { sessions: 0, tokens: 0 }]));
  let sessions = 0;
  let files = 0;
  for (const file of sessionFiles(path.join(codexHomeDir(env), 'sessions'), sinceMs)) {
    if (++files > MAX_FILES) break;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      const s = sessionOf(file);
      if (s === null || !(s.at >= sinceMs)) continue;
      byKind[s.kind].sessions += 1;
      byKind[s.kind].tokens += s.tokens;
      sessions += 1;
    } catch { /* unreadable: skipped */ }
  }
  const totalTokens = KINDS.reduce((sum, k) => sum + byKind[k].tokens, 0);
  const mtok = (n) => (n / 1e6).toFixed(1);
  const parts = KINDS.filter((k) => byKind[k].sessions > 0).map((k) => `${k} ${mtok(byKind[k].tokens)}M (${byKind[k].sessions})`);
  const line = `- ${new Date(now).toISOString().slice(0, 10)} · Codex usage since ${new Date(sinceMs).toISOString().slice(0, 10)} · ${mtok(totalTokens)}M tokens in ${sessions} session${sessions === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  return { since: new Date(sinceMs).toISOString(), sessions, totalTokens, byKind, line };
}
