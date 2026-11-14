// Cost attribution for a review run (issue #57 item 1): tokens and USD by phase and by role, plus how often the run
// retried and how many times the guards denied one of its commands. It rides in the run record (`record.cost`), so
// `P summary` can show it and old records simply lack it. Pure except `readGuardLog` (one file read). Display only:
// nothing here may change what a command decides.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Who spent the tokens. Anything not named here is booked as `other` (never dropped, never a new key).
export const ROLES = Object.freeze(['implementer', 'judge', 'arbiter', 'substitute-opus', 'substitute-fable', 'verifier', 'controller', 'other']);
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

const BUCKET_KEY_RE = /^[^|]{1,100}\|(?:std|>100k)\|(?:std|fast)$/;
const BUCKET_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'messages'];
const TABLE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Adds the entry's `byPrice` buckets into `into` (a plain object), summing per key.
function mergeByPrice(into, add) {
  if (!isPlainObject(add)) throw new Error('byPrice must be an object');
  const out = isPlainObject(into) ? into : {};
  for (const [key, v] of Object.entries(add)) {
    if (!BUCKET_KEY_RE.test(key)) throw new Error(`byPrice key ${JSON.stringify(key.slice(0, 40))} is not "<model>|<std|>100k>|<std|fast>"`);
    if (!isPlainObject(v)) throw new Error('byPrice entries must be objects');
    const b = isPlainObject(out[key]) ? out[key] : {};
    out[key] = Object.fromEntries(BUCKET_FIELDS.map((k) => [k, (Number(b[k]) || 0) + amount(v[k], `byPrice ${k}`, { integer: true })]));
  }
  return out;
}

// entry: {phase, role, input, output, cacheRead, cacheWrite, usd, round?, byPrice?, priceTable?}. `round` (a positive integer: the review round the call served) also
// adds the entry into cost.byRound[round]. `byPrice` (see usageFromTranscript) is summed
// into cost.byPrice; `priceTable` (a date) counts the entry in cost.priceTables. Returns a NEW cost object (input is not touched).
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
  if (entry?.round !== undefined) {
    const round = entry.round;
    if (!Number.isInteger(round) || round < 1) throw new Error('round must be a whole number of at least 1');
    const byRound = isPlainObject(next.byRound) ? next.byRound : {};
    byRound[String(round)] = addTotals(byRound[String(round)], add);
    next.byRound = byRound;
  }
  if (entry?.byPrice !== undefined) next.byPrice = mergeByPrice(next.byPrice, entry.byPrice);
  if (entry?.priceTable !== undefined) {
    if (typeof entry.priceTable !== 'string' || !TABLE_DATE_RE.test(entry.priceTable)) throw new Error('priceTable must be a date (YYYY-MM-DD)');
    const tables = isPlainObject(next.priceTables) ? next.priceTables : {};
    tables[entry.priceTable] = (Number(tables[entry.priceTable]) || 0) + 1;
    next.priceTables = tables;
  }
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
  // byPrice / priceTables are optional (records from before per-version prices have neither) but must be indexable when present
  if (cost.byPrice !== undefined && !isPlainObject(cost.byPrice)) return 'bad cost';
  if (cost.priceTables !== undefined && !isPlainObject(cost.priceTables)) return 'bad cost';
  // byRound (cost booked per review round) is optional too: plain object, keys positive integer strings, values plain objects
  if (cost.byRound !== undefined) {
    if (!isPlainObject(cost.byRound)) return 'bad cost';
    for (const [k, v] of Object.entries(cost.byRound)) if (!/^[1-9]\d{0,8}$/.test(k) || !isPlainObject(v)) return 'bad cost';
  }
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
// USD per million tokens [input, output, cache read, cache write 5 min, cache write 1 h] per model VERSION (the claude-api
// skill table of PRICE_TABLE_DATE; a cache write costs 1.25x input for 5 min and 2x for 1 h). An estimate, not a bill
// (plans and discounts differ); a model this table does not know adds tokens and no USD. Display only.
export const PRICE_TABLE_DATE = '2026-11-03';
export const PRICES = Object.freeze({
  'claude-fable-5-2': [8, 40, 0.2, 10, 16],
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
});
// Haiku 5.5 prices a message by its own prompt size (input + cache read + cache write): above 100,000 tokens the higher row.
export const TIER_THRESHOLD_TOKENS = 100000;
export const PRICES_OVER_100K = Object.freeze({ 'claude-haiku-5-5': [0.5, 2.5, 0.05, 0.625, 1] });
// Fast mode (usage.speed 'fast') re-prices input and output only; its cache prices are not known, so a fast message with any
// cache tokens is left unpriced rather than guessed.
export const FAST_PRICES = Object.freeze({ 'claude-fable-5-2': [16, 80], 'claude-opus-5-5': [8, 40] });
// A family's newest row prices a version this table does not know yet (a newer Fable is priced like Fable 5.2).
const FAMILY_NEWEST = Object.freeze({ fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });

export const modelFamily = (model) => {
  const m = String(model ?? '').toLowerCase();
  return /fable/.test(m) ? 'fable' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /opus/.test(m) ? 'opus' : null;
};
// The table row id a model is priced as: the id itself (a `[1m]`-style suffix and an 8-digit date suffix dropped), else its
// family's newest row, else null.
export function priceRowId(model) {
  const id = String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  if (Object.hasOwn(PRICES, id)) return id;
  const family = modelFamily(id);
  return family ? FAMILY_NEWEST[family] : null;
}

const tok = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
// {input, output, cacheRead, cacheWrite5m, cacheWrite1h} from a token object; a bare `cacheWrite` (no split given) is 5 min.
function splitTokens(t) {
  const split = t.cacheWrite5m !== undefined || t.cacheWrite1h !== undefined;
  return {
    input: tok(t.input), output: tok(t.output), cacheRead: tok(t.cacheRead),
    cacheWrite5m: split ? tok(t.cacheWrite5m) : tok(t.cacheWrite), cacheWrite1h: split ? tok(t.cacheWrite1h) : 0,
  };
}
const promptTokens = (x) => x.input + x.cacheRead + x.cacheWrite5m + x.cacheWrite1h;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// {tier: 'std' | '>100k', speed: 'std' | 'fast', usd: number | null} for one message's tokens. `usd` is null when the model is
// unknown, or the message is fast without a fast price (or with cache tokens).
export function priceMessage(model, t, { speed } = {}) {
  const x = splitTokens(t ?? {});
  const row = priceRowId(model);
  const fast = speed === 'fast' ? 'fast' : 'std';
  const tier = row !== null && PRICES_OVER_100K[row] && promptTokens(x) > TIER_THRESHOLD_TOKENS ? '>100k' : 'std';
  if (row === null) return { tier, speed: fast, usd: null };
  if (fast === 'fast') {
    const f = FAST_PRICES[row];
    if (!f || x.cacheRead + x.cacheWrite5m + x.cacheWrite1h > 0) return { tier, speed: fast, usd: null };
    return { tier, speed: fast, usd: round6((x.input * f[0] + x.output * f[1]) / 1e6) };
  }
  const p = tier === '>100k' ? PRICES_OVER_100K[row] : PRICES[row];
  return { tier, speed: fast, usd: round6((x.input * p[0] + x.output * p[1] + x.cacheRead * p[2] + x.cacheWrite5m * p[3] + x.cacheWrite1h * p[4]) / 1e6) };
}
// USD for a token count at a model's list price; null when the model is unknown.
export const listPriceUsd = (model, t, opts) => priceMessage(model, t, opts).usd;

// ---- token usage from a Claude transcript (JSONL) ------------------------------------------------------------------

// Sums message.usage over the assistant lines of one transcript. A streamed message may appear on several lines with
// the same message id; each id is counted once (last line wins, it carries the final totals). `defaultModel` prices the messages that carry
// no model of their own (a message's own model always wins). `byPrice` ("<model id>|<tier>|<speed>" -> token sums and a message count)
// holds every dimension the price depends on, so a later table can re-price the run exactly; `cacheWrite` stays the 5 m + 1 h total.
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
  // usd: each message at its own model's list price; unpricedMessages: messages the price table cannot price
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, messages: byId.size, unpricedMessages: 0, byPrice: {} };
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  for (const { u, model } of byId.values()) {
    const cc = isPlainObject(u.cache_creation) ? u.cache_creation : {};
    const total = n(u.cache_creation_input_tokens);
    const split = cc.ephemeral_1h_input_tokens !== undefined || cc.ephemeral_5m_input_tokens !== undefined;
    const w1h = split ? n(cc.ephemeral_1h_input_tokens) : 0;
    // (a total larger than the two parts is booked as 5 min; no split at all means all 5 min)
    const w5m = split ? n(cc.ephemeral_5m_input_tokens) + Math.max(0, total - n(cc.ephemeral_5m_input_tokens) - w1h) : total;
    const t = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: w5m, cacheWrite1h: w1h };
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite += w5m + w1h;
    const id = (typeof model === 'string' && model !== '' ? model : typeof defaultModel === 'string' && defaultModel !== '' ? defaultModel : 'unknown').replaceAll('|', '_');
    const priced = priceMessage(id, t, { speed: u.speed });
    if (priced.usd === null) sum.unpricedMessages++;
    else sum.usd += priced.usd;
    const key = `${id}|${priced.tier}|${priced.speed}`;
    const b = (sum.byPrice[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 0 });
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) b[k] += t[k];
    b.messages += 1;
  }
  sum.usd = round6(sum.usd);
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
  if (isPlainObject(cost.byRound)) {
    const keys = Object.keys(cost.byRound).filter((k) => isPlainObject(cost.byRound[k])).sort((a, b) => Number(a) - Number(b));
    if (keys.length) out.push(`- **By round:** ${keys.map((k) => `round ${k} ${usd(cost.byRound[k].usd)} (${num((Number(cost.byRound[k].input) || 0) + (Number(cost.byRound[k].output) || 0))} tok)`).join(' · ')}`);
  }
  const tables = isPlainObject(cost.priceTables) ? Object.entries(cost.priceTables) : [];
  if (tables.length) out.push(`- **Priced with table:** ${tables.map(([d, c]) => `${d} (${num(c)})`).join(' · ')}`);
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
    ...(isPlainObject(cost.byRound) ? { byRound: cost.byRound } : {}),
    ...(isPlainObject(cost.byPrice) ? { byPrice: cost.byPrice } : {}),
    ...(isPlainObject(cost.priceTables) ? { priceTables: cost.priceTables } : {}),
  };
}
