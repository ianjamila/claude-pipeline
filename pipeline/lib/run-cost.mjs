// Cost attribution for a `ship` run (issue #57 item 1): tokens and USD by phase and by role, plus how often the run
// retried and how many times the guards denied one of its commands. It rides in the run record (`record.cost`), so
// `P summary` can show it and old records simply lack it. Pure except `readGuardLog` (one file read). Display only:
// nothing here may change what a command decides.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Who spent the tokens. Anything not named here is booked as `other` (never dropped, never a new key).
export const ROLES = Object.freeze(['implementer', 'judge', 'arbiter', 'verifier', 'controller', 'other']);
// The run's phases are the record steps (a test pins this list to run-record's STEPS: that module imports this one, so it
// cannot be imported back); a phase the caller invents is booked as `other`.
export const PHASES = Object.freeze(['build', 'verify', 'pr', 'review', 'gate', 'awaiting-owner-merge', 'merge', 'prod-watch', 'ended', 'other']);

export const MAX_SESSIONS = 20;
const SESSION_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 });
export const emptyCost = () => ({ total: emptyTotals(), byPhase: {}, byRole: {}, retries: 0, guardBlocks: null, sessions: [] });

export const normaliseRole = (role) => (ROLES.includes(role) ? role : 'other');
export const normalisePhase = (phase) => (PHASES.includes(phase) ? phase : 'other');

// A count or amount from a flag / a file: a non-negative finite number, else a thrown error that names the field.
function amount(v, what, { integer }) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a non-negative number`);
  if (integer && !Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
  return n;
}

function addTotals(into, add) {
  const t = { ...emptyTotals(), ...(isPlainObject(into) ? into : {}) };
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) t[k] = (Number(t[k]) || 0) + add[k];
  t.usd = Math.round(((Number(t.usd) || 0) + add.usd) * 1e6) / 1e6;
  return t;
}

// entry: {phase, role, input, output, cacheRead, cacheWrite, usd}. Returns a NEW cost object (input is not touched).
export function addCostEntry(cost, entry) {
  const next = structuredClone(isPlainObject(cost) ? { ...emptyCost(), ...cost } : emptyCost());
  const add = {
    input: amount(entry?.input, 'input tokens', { integer: true }),
    output: amount(entry?.output, 'output tokens', { integer: true }),
    cacheRead: amount(entry?.cacheRead, 'cache-read tokens', { integer: true }),
    cacheWrite: amount(entry?.cacheWrite, 'cache-write tokens', { integer: true }),
    usd: amount(entry?.usd, 'usd', { integer: false }),
    calls: 1,
  };
  const phase = normalisePhase(entry?.phase);
  const role = normaliseRole(entry?.role);
  next.total = addTotals(next.total, add);
  next.byPhase[phase] = addTotals(next.byPhase[phase], add);
  next.byRole[role] = addTotals(next.byRole[role], add);
  return next;
}

export function addSessions(cost, ids) {
  const next = structuredClone(isPlainObject(cost) ? { ...emptyCost(), ...cost } : emptyCost());
  for (const id of ids ?? []) {
    if (!SESSION_RE.test(String(id))) throw new Error(`session id ${JSON.stringify(String(id).slice(0, 20))}… is not a plain id`);
    if (!next.sessions.includes(String(id))) next.sessions.push(String(id));
  }
  next.sessions = next.sessions.slice(-MAX_SESSIONS);
  return next;
}

export function addRetries(cost, n = 1) {
  const next = structuredClone(isPlainObject(cost) ? { ...emptyCost(), ...cost } : emptyCost());
  next.retries = (Number(next.retries) || 0) + amount(n, 'retries', { integer: true });
  return next;
}

// `bySession` ({sessionId: denies}, at most MAX_SESSIONS of them, the last ones kept) replaces the per-session counts; left out, they stay.
export function setGuardBlocks(cost, n, bySession) {
  const next = structuredClone(isPlainObject(cost) ? { ...emptyCost(), ...cost } : emptyCost());
  next.guardBlocks = n === null ? null : amount(n, 'guard blocks', { integer: true });
  if (n === null) next.guardBySession = null;
  else if (bySession !== undefined) {
    next.guardBySession = Object.fromEntries(Object.entries(bySession ?? {}).slice(-MAX_SESSIONS).map(([id, v]) => {
      if (!SESSION_RE.test(id)) throw new Error(`session id ${JSON.stringify(id.slice(0, 20))}… is not a plain id`);
      return [id, amount(v, 'guard blocks', { integer: true })];
    }));
  }
  return next;
}

// Fails the record shape check for a cost section no reader can index.
export function costShapeProblem(cost) {
  if (cost === undefined || cost === null) return null;
  if (!isPlainObject(cost)) return 'bad cost';
  if (!isPlainObject(cost.total) || !isPlainObject(cost.byPhase) || !isPlainObject(cost.byRole)) return 'bad cost';
  return null;
}

// ---- guard denies ------------------------------------------------------------------------------------------------

export const guardLogFile = (home = homedir()) => join(home, '.claude', 'pipeline-state', 'guard-log.jsonl');

// Counts the deny lines whose session is one of `sessions`. The file is written by the guard hooks, one JSON line per
// deny: {ts, session, hook, reason_code, cmd_hash}. Absent file => {present: false, blocks: 0}; a line that is not JSON
// or has no string session is counted in `skipped` and never trusted.
export function readGuardLog(file, sessions) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { present: false, blocks: 0, bySession: {}, skipped: 0 };
  }
  const wanted = new Set((sessions ?? []).map(String));
  const bySession = {};
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isPlainObject(e) || typeof e.session !== 'string' || e.session === '') {
      skipped += 1;
      continue;
    }
    if (wanted.has(e.session)) bySession[e.session] = (bySession[e.session] ?? 0) + 1;
  }
  for (const id of wanted) bySession[id] ??= 0; // (a session with no denies is listed with 0)
  return { present: true, blocks: Object.values(bySession).reduce((a, b) => a + b, 0), bySession, skipped };
}

// ---- list prices ---------------------------------------------------------------------------------------------------

// Why: an agent knows the tokens a subagent used but rarely its price, so USD was 0 unless passed by hand. List prices in
// USD per million tokens [input, output, cache read, cache write (5 min)], the same proxy as the owner's weekly usage report.
// An estimate, not a bill (plans and discounts differ); a model this table does not know adds tokens and no USD.
export const PRICES = Object.freeze({
  opus: [5, 25, 0.5, 6.25], sonnet: [3, 15, 0.3, 3.75], haiku: [1, 5, 0.1, 1.25], fable: [12.5, 62.5, 1.25, 15.6],
});
export const modelFamily = (model) => {
  const m = String(model ?? '').toLowerCase();
  return /fable/.test(m) ? 'fable' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /opus/.test(m) ? 'opus' : null;
};
// USD for a token count at a model's list price; null when the model is unknown.
export function listPriceUsd(model, t) {
  const p = PRICES[modelFamily(model)];
  if (!p) return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const usd = (n(t.input) * p[0] + n(t.output) * p[1] + n(t.cacheRead) * p[2] + n(t.cacheWrite) * p[3]) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// ---- token usage from a Claude transcript (JSONL) ------------------------------------------------------------------

// Sums message.usage over the assistant lines of one transcript. A streamed message may appear on several lines with
// the same message id; each id is counted once (last line wins, it carries the final totals). `defaultModel` prices the messages that carry
// no model of their own (a message's own model always wins).
export function usageFromTranscript(text, { defaultModel } = {}) {
  const byId = new Map();
  let anon = 0;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    const u = e?.message?.usage;
    if (!isPlainObject(u)) continue;
    byId.set(e.message.id ?? `anon-${anon++}`, { u, model: e.message.model });
  }
  // usd: each message at its own model's list price; unpricedMessages: messages whose model the price table does not know
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, messages: byId.size, unpricedMessages: 0 };
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  for (const { u, model } of byId.values()) {
    const t = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite += t.cacheWrite;
    const price = listPriceUsd(typeof model === 'string' && model !== '' ? model : defaultModel, t);
    if (price === null) sum.unpricedMessages++;
    else sum.usd += price;
  }
  sum.usd = Math.round(sum.usd * 1e6) / 1e6;
  return sum;
}

// ---- display -------------------------------------------------------------------------------------------------------

const usd = (v) => `$${(Number(v) || 0).toFixed(2)}`;
const num = (v) => String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tokens = (t) => `in ${num(t.input)} · out ${num(t.output)} · cache read ${num(t.cacheRead)} · cache write ${num(t.cacheWrite)}`;

// Status-block lines for a record's cost section; [] for an old record that has none (or an empty one).
export function costLines(cost) {
  if (costShapeProblem(cost) || cost == null) return [];
  const total = { ...emptyTotals(), ...cost.total };
  const retries = Number(cost.retries) || 0;
  const hasGuard = Number.isInteger(cost.guardBlocks);
  if (!total.calls && !retries && !hasGuard) return [];
  const out = [`- **Cost:** ${usd(total.usd)} · ${tokens(total)} · ${num(total.calls)} call${total.calls === 1 ? '' : 's'}`];
  const per = hasGuard && isPlainObject(cost.guardBySession) ? Object.entries(cost.guardBySession) : [];
  out.push(`- **Retries:** ${num(retries)} · **Guard blocks:** ${hasGuard ? num(cost.guardBlocks) : '—'}${per.length ? ` (${per.map(([id, n]) => `${id} ${num(n)}`).join(' · ')})` : ''}`);
  const rows = (label, order, map) => {
    const keys = order.filter((k) => isPlainObject(map?.[k]));
    if (!keys.length) return;
    out.push(`- **${label}:** ${keys.map((k) => `${k} ${usd(map[k].usd)} (${num((Number(map[k].input) || 0) + (Number(map[k].output) || 0))} tok)`).join(' · ')}`);
  };
  rows('By phase', PHASES, cost.byPhase);
  rows('By role', ROLES, cost.byRole);
  return out;
}

// What `P summary` reports in its JSON: the same numbers, plain.
export function costReport(cost) {
  if (costShapeProblem(cost) || cost == null) return null;
  return {
    total: { ...emptyTotals(), ...cost.total },
    byPhase: cost.byPhase,
    byRole: cost.byRole,
    retries: Number(cost.retries) || 0,
    guardBlocks: Number.isInteger(cost.guardBlocks) ? cost.guardBlocks : null,
    guardBySession: Number.isInteger(cost.guardBlocks) && isPlainObject(cost.guardBySession) ? cost.guardBySession : null,
    sessions: Array.isArray(cost.sessions) ? cost.sessions : [],
  };
}
