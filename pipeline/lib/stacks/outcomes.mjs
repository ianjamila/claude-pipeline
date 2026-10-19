// The decisions log of stack-stop and what the owner reads from it: per-generation would-stops, their outcomes, the sweep
// report and the weekly section. Spec section 6; plan Task 9 with R2-8 and R2-9.
//
// Decisions log. `actions.jsonl` (stackFiles(root).actions) holds one record per decision: { t, source, project, generation,
// mode, action, reasons, evidence?, memBytes?, alert? } (act.mjs's `log` callback writes them through appendDecision). It is
// written with the ledger's append (one fsynced line, ISO `t` required, MAX_LINE) under ITS OWN lock, `<locks>/actions`, so a
// decision never waits for a lease append or a ledger repair (and the register hook never waits for a decision). Callers
// that already hold a project lock may append: project locks come first, this lock second, like the ledger lock. Reading is
// strict: one damaged line makes the whole log `unknown`, never a partial answer (the register hook has its own tolerant tail
// reader for the "just stopped?" check; this one feeds the numbers the owner switches stopping on from).
//
// Outcomes. Every would-stop / stopped decision is reported once per container generation (project|generation id|StartedAt),
// as ONE row: the first record names the row, later records of the same generation (later sweeps, later sessions) only move
// `lastSeen`. A "use" is { t, project, pid, birth, command?, check? } -- a lease, a C2 connection or a C3 reference seen after
// the decision, with the process identity read at observation. It is judged against the NEWEST stop record of that project that
// is not later than the use (every record of a generation counts, not only the first: in report mode a private stack lives for
// days and is would-stopped again and again), then rolled up into that record's generation row:
//   - the use is from 0 to 2 h (both ends inclusive) after the decision, else it is not an outcome;
//   - birth BEFORE the decision time => MISS (a live consumer the checks missed: the safety signal);
//   - birth at or after it => RESTART (cost only, the data was kept);
//   - no usable birth (hidden client, process gone before ps could read it, unparsable time) => UNKNOWN (R2-9). An UNKNOWN
//     could be a MISS, so it blocks the switch-on recommendation exactly like one: the headline reads "MISS 0 (+2 unknown
//     => not yet)".
// A row's outcome is the worst class over all its records' uses (MISS > UNKNOWN > RESTART); with no use it is PENDING until the
// NEWEST record's 2 h window is over, then CLEAN -- but only when somebody watched (F2). A session-end would-stop is watched by
// its worker's +30 / +120 min probes, which write an `observed` record after the last one (`observation-late`: the probe fired
// past its grace, so its time is outside the window; `observation-lost`: the worker died before finishing and the sweep removed
// its file). With no `observed` record at or after the newest record, or with a late / lost one, the row is UNKNOWN: "no use"
// proves nothing when nothing was looked at. These three actions are markers, never decisions. A sweep-sourced would-stop has no
// observer of its own (the sweeps after it are what sees uses), so its CLEAN rule is unchanged. The summary covers the last 7 days
// (by the newest record).
//
// Time comes in as inputs (`now`, record `t`); nothing here reads a clock except as a default argument.
import path from 'node:path';
import { run as realRun } from '../proc.mjs';
import { MAX_LINE, appendEvent, readLedger, validIsoTime } from './ledger.mjs';
import { stackFiles } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const WINDOW_MS = 2 * 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const GIB = 1024 ** 3;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (s) => String(s ?? '').toLowerCase();
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const oneLine = (s, max = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const when = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown time');

// ---------------------------------------------------------------- the log

// The decisions log has its own lock directory, disjoint from project/ledger/sweep/dev (R3-3).
const actionsLockDir = (file) => path.join(stackFiles(path.dirname(file)).locks, 'actions');

// Keeps the decision when its evidence is too big for one ledger line: the evidence blob is replaced by a marker and the
// reasons are capped. The decision itself (project, generation, action, alert) is what matters most and always fits.
function shrink(rec) {
  const reasons = Array.isArray(rec.reasons) ? rec.reasons.slice(0, 20).map((r) => String(r).slice(0, 200)) : rec.reasons;
  return { ...rec, reasons, evidence: { truncated: true } };
}

// ok(undefined) | unknown. `rec` = { t, source, project, generation, action, reasons, evidence, memBytes?, alert? }.
export async function appendDecision(file, rec, { lockDir = actionsLockDir(file), waitMs, deadlineAt, now, pollMs } = {}) {
  if (!isObject(rec)) return unknown('decision is not an object');
  if (!validIsoTime(rec.t)) return unknown('decision has no valid ISO time t');
  if (typeof rec.project !== 'string' || rec.project === '') return unknown('decision names no project');
  if (typeof rec.action !== 'string' || rec.action === '') return unknown('decision names no action');
  let out = rec;
  try {
    if (Buffer.byteLength(JSON.stringify(rec)) > MAX_LINE) out = shrink(rec);
  } catch (err) {
    return unknown(`decision cannot be serialised: ${err.message}`);
  }
  return appendEvent(file, out, { lockDir, waitMs, deadlineAt, now, pollMs });
}

// ok(rec[]) | unknown. Missing file => ok([]); any damaged line => unknown (nothing partial).
export function readDecisions(file) {
  const r = readLedger(file);
  return r.ok ? r : unknown(r.reason.replace(/^damaged ledger/, 'damaged actions log'));
}

// ---------------------------------------------------------------- would-stops

const STOP_ACTIONS = new Set(['would-stop', 'stopped']);
// Observation markers of a generation (session-end / sweep write them with `store(..., { decision: false })`); not decisions.
export const OBSERVATION_ACTIONS = Object.freeze(['observed', 'observation-late', 'observation-lost']);
export const generationKey = (rec) => `${lower(rec?.project)}|${rec?.generation?.id ?? ''}|${rec?.generation?.startedAt ?? ''}`;

// Every would-stop / stopped record, oldest first (log order breaks ties): what a use is charged to.
export function stopRecords(decisions) {
  const list = (decisions ?? []).filter((r) => isObject(r) && STOP_ACTIONS.has(r.action));
  return list.map((r, i) => [r, i]).sort((a, b) => toMs(a[0].t) - toMs(b[0].t) || a[1] - b[1]).map(([r]) => r);
}

// The newest stop record of `project` (case-insensitive) that is not later than `atMs`; an unplaceable time (NaN) is charged to the
// newest record of the project (classifyUse answers UNKNOWN for it). undefined when none.
export function newestStopAt(stops, project, atMs) {
  const p = lower(project);
  const mine = stops.filter((r) => lower(r.project) === p);
  return Number.isFinite(atMs) ? [...mine].reverse().find((r) => toMs(r.t) <= atMs) : mine[mine.length - 1];
}

// Map<"project|genId|startedAt", rec + lastSeen>, in log order. One record per container generation: the first would-stop /
// stopped record wins; later records of the same generation (later sweeps) only move `lastSeen`. A restarted container has a
// new StartedAt, so it is a new would-stop. kept / failed / skipped records are not would-stops and move nothing.
export function wouldStops(decisions) {
  const out = new Map();
  for (const rec of decisions ?? []) {
    if (!isObject(rec) || !STOP_ACTIONS.has(rec.action)) continue;
    const key = generationKey(rec);
    const seen = out.get(key);
    if (!seen) {
      out.set(key, { ...rec, lastSeen: rec.t });
    } else if (toMs(rec.t) > toMs(seen.lastSeen)) {
      seen.lastSeen = rec.t;
    }
  }
  return out;
}

// ---------------------------------------------------------------- outcomes

// 'MISS' | 'RESTART' | 'UNKNOWN' | null. `use` = { t, pid, birth } (birth = epoch seconds). null = not an outcome of `rec`.
export function classifyUse(rec, use) {
  if (!isObject(rec) || !isObject(use)) return null;
  const decided = toMs(rec.t);
  const at = toMs(use.t);
  if (!Number.isFinite(decided) || !Number.isFinite(at)) return 'UNKNOWN'; // cannot be placed in time: never ignored
  const dt = at - decided;
  if (dt < 0 || dt > WINDOW_MS) return null;
  if (typeof use.birth !== 'number' || !Number.isFinite(use.birth)) return 'UNKNOWN';
  return use.birth * 1000 < decided ? 'MISS' : 'RESTART';
}

const RANK = { MISS: 3, UNKNOWN: 2, RESTART: 1 };

// -> { miss, restart, unknown, clean, pending, gbFreed, rows } over the generations whose newest would-stop is from the last 7 days.
// `uses` = [{ t, project, pid, birth, command?, check? }]; each use is judged against the newest would-stop record of its project
// that is not later than the use (the use of an older generation is not charged to a newer one) and rolled up into that record's
// generation row. rows are in decision order, one per generation.
export function outcomeSummary(decisions, uses, now = Date.now()) {
  const nowMs = toMs(now);
  const stops = stopRecords(decisions);
  const rowOf = new Map(); // generation key -> { rec (first record) + lastSeen, newest (newest record) }
  for (const rec of decisions ?? []) {
    if (!isObject(rec) || !STOP_ACTIONS.has(rec.action)) continue;
    const key = generationKey(rec);
    const g = rowOf.get(key);
    if (!g) rowOf.set(key, { rec: { ...rec, lastSeen: rec.t }, newest: rec });
    else if (toMs(rec.t) >= toMs(g.newest.t)) {
      g.newest = rec;
      g.rec.lastSeen = rec.t;
    }
  }
  const marks = new Map(); // generation key -> [{ action, ms }]
  for (const rec of decisions ?? []) {
    if (!isObject(rec) || !OBSERVATION_ACTIONS.includes(rec.action)) continue;
    const key = generationKey(rec);
    if (!marks.has(key)) marks.set(key, []);
    marks.get(key).push({ action: rec.action, ms: toMs(rec.t) });
  }
  const hits = new Map(); // generation key -> [{ ...use, class, against }]
  for (const use of uses ?? []) {
    const target = newestStopAt(stops, use?.project, toMs(use?.t));
    if (!target) continue;
    const cls = classifyUse(target, use);
    if (!cls) continue;
    const key = generationKey(target);
    if (!hits.has(key)) hits.set(key, []);
    hits.get(key).push({ ...use, class: cls, against: target.t });
  }
  const sum = { miss: 0, restart: 0, unknown: 0, clean: 0, pending: 0, gbFreed: 0, rows: [] };
  let bytes = 0;
  for (const [key, { rec, newest }] of rowOf) {
    const decided = toMs(rec.t);
    const newestMs = toMs(newest.t);
    if (!(newestMs >= nowMs - WEEK_MS)) continue;
    const used = hits.get(key) ?? [];
    const worst = used.reduce((w, u) => (RANK[u.class] > (RANK[w] ?? 0) ? u.class : w), null);
    let outcome = worst ?? (nowMs >= newestMs + WINDOW_MS ? 'CLEAN' : 'PENDING');
    let note = null;
    if (outcome === 'CLEAN' && newest.source === 'session-end') {
      const after = (marks.get(key) ?? []).filter((m) => m.ms >= newestMs);
      if (after.some((m) => m.action === 'observation-lost')) note = 'the worker died before its re-probes finished: nothing proves the stack was unused';
      else if (after.some((m) => m.action === 'observation-late')) note = 'the last re-probe ran too late, outside the 2 h window: nothing proves the stack was unused';
      else if (!after.some((m) => m.action === 'observed')) note = 'no re-probe was recorded after the would-stop: nothing proves the stack was unused';
      if (note) outcome = 'UNKNOWN';
    }
    sum[outcome.toLowerCase()] += 1;
    const memBytes = typeof rec.memBytes === 'number' && Number.isFinite(rec.memBytes) ? rec.memBytes : null;
    if (memBytes !== null) bytes += memBytes;
    sum.rows.push({
      project: rec.project, t: rec.t, lastSeen: rec.lastSeen, generation: rec.generation ?? null, action: rec.action, source: rec.source ?? null,
      memBytes, outcome, uses: used, ...(note ? { note } : {}), cleanDays: outcome === 'CLEAN' ? Math.floor((nowMs - decided) / DAY_MS) : null,
    });
  }
  sum.rows.sort((a, b) => toMs(a.t) - toMs(b.t));
  sum.gbFreed = Math.round((bytes / GIB) * 100) / 100;
  return sum;
}

// ---------------------------------------------------------------- memory (the benefit of a would-stop)

const UNITS = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function parseSize(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(String(text ?? ''));
  const unit = m ? UNITS[m[2].toLowerCase()] : undefined;
  return unit === undefined ? null : Number(m[1]) * unit;
}
const SERVICES = 'db|kong|auth|rest|storage|realtime|inbucket|mailpit|studio|pg_meta|edge_runtime|vector|analytics|imgproxy|pooler|logflare';
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ok(bytes) | unknown. Sum of `docker stats --no-stream` memory of the running containers `supabase_<service>_<project>`
// (service from the Supabase CLI's list, so `supabase_db_other_foo` is not project `foo`). Unknown when docker fails, no
// container of the project is listed, or a figure cannot be read: the caller then records the would-stop without a size.
export function memoryOfProject(project, { run = realRun, docker = 'docker', deadlineAt, now = Date.now } = {}) {
  const left = deadlineAt === undefined || deadlineAt === null ? Infinity : deadlineAt - now();
  if (left < 500) return unknown('deadline');
  let r;
  try {
    r = run(docker, ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'], { timeoutMs: Math.min(20_000, left) });
  } catch (err) {
    return unknown(`docker stats could not run: ${err?.message ?? err}`);
  }
  if (!r || r.timedOut || r.signal) return unknown('docker stats timed out or was killed');
  if (r.code !== 0) return unknown(`docker stats exit ${r.code}: ${oneLine(r.stderr, 120)}`);
  const re = new RegExp(`^supabase_(?:${SERVICES})_${escapeRe(project)}$`, 'i');
  let total = 0;
  let rows = 0;
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const [name, usage] = line.split('\t');
    if (!name || !re.test(name.trim())) continue;
    const bytes = parseSize(String(usage ?? '').split('/')[0]);
    if (bytes === null) return unknown(`unreadable memory figure for ${name.trim()}: ${oneLine(usage, 40)}`);
    total += bytes;
    rows += 1;
  }
  return rows === 0 ? unknown(`docker stats lists no running container of ${project}`) : ok(Math.round(total));
}

// ---------------------------------------------------------------- reports

// Decisions that carry an alert, optionally only those since `sinceMs`.
function alertsOf(decisions, sinceMs = null) {
  return (decisions ?? []).filter((d) => isObject(d) && d.alert && (sinceMs === null || toMs(d.t) >= sinceMs));
}

function alertLines(decisions, sinceMs) {
  const list = alertsOf(decisions, sinceMs);
  const line = (d, head) => `- ${head}: ${oneLine(d.project)} (${d.t}) — ${oneLine((d.reasons ?? []).join('; '), 240)}`;
  return [
    ...list.filter((d) => d.alert === 'db-volume-missing').map((d) => line(d, 'ALERT db-volume-missing — the database volume was not found after the stop; check Docker volumes before anything else')),
    ...list.filter((d) => d.alert === 'post-check-unknown').map((d) => line(d, 'post-check-unknown — the stop was not fully verified')),
  ];
}

const missHeadline = (s) => (s.unknown > 0 ? `MISS ${s.miss} (+${s.unknown} unknown ⇒ not yet)` : `MISS ${s.miss} (must be 0 to switch on)`);

function useLine(row, u) {
  const who = u.pid === null || u.pid === undefined ? 'hidden client' : `pid ${u.pid}${u.command ? ` (${oneLine(u.command, 80)})` : ''}`;
  const born = typeof u.birth === 'number' && Number.isFinite(u.birth) ? `born ${when(u.birth * 1000)}` : 'birth unknown';
  return `- ${oneLine(row.project)} — would-stop ${u.against ?? row.t} — ${who}, ${born}, seen ${u.t}${u.check ? `, missed by the ${oneLine(u.check, 40)} check` : ''}`;
}

function outcomeSection(title, rows, cls, none) {
  const picked = rows.filter((r) => r.outcome === cls);
  if (picked.length === 0) return [`## ${title}`, none, ''];
  return [`## ${title}`, ...picked.flatMap((r) => {
    const lines = r.uses.filter((u) => u.class === cls).map((u) => useLine(r, u));
    return lines.length === 0 && r.note ? [`- ${oneLine(r.project)} — would-stop ${r.lastSeen ?? r.t} — ${r.note}`] : lines;
  }), ''];
}

function listedLine(l) {
  const reasons = (l.reasons ?? []).map((r) => oneLine(r, 200)).join('; ') || 'no reason recorded';
  const hidden = Number.isInteger(l.hidden) && l.hidden > 0 ? ` — hidden: ${l.hidden} other-user process${l.hidden === 1 ? '' : 'es'} whose environment and files cannot be read` : '';
  return `- ${oneLine(l.project)} (${l.verdict ?? 'listed'}): ${reasons}${hidden}`;
}

function devLine(d) {
  const up = Number.isFinite(d.uptimeS) ? `${Math.floor(d.uptimeS / 3600)} h ${Math.floor((d.uptimeS % 3600) / 60)} min` : 'uptime unknown';
  const owner = d.boundOwnerAlive === true ? 'owner alive' : d.boundOwnerAlive === false ? 'owner gone' : 'owner unknown';
  return `- :${d.port} pid ${d.pid ?? '?'} cwd ${oneLine(d.cwd, 120)}${d.worktree ? ` (worktree ${oneLine(d.worktree, 120)})` : ''}, up ${up}, ${owner} — ${d.verdict ?? 'unknown'}`;
}

function switchOn(s) {
  const total = s.miss + s.restart + s.unknown + s.clean + s.pending;
  if (s.miss > 0) return 'no — a MISS means a live consumer was missed; fix the check before switching anything on';
  if (s.unknown > 0) return `not yet — ${s.unknown} outcome(s) without a readable process identity, or never observed, count as MISS until explained`;
  if (total === 0) return 'not yet — no would-stop was recorded in the last 7 days, so there is no evidence';
  if (s.pending > 0) return `wait — ${s.pending} would-stop(s) are still inside their 2 h window`;
  return `the evidence is clean (no MISS, no unknown across ${total} would-stop(s)); switching on is the owner's decision`;
}

// state = { now, decisions, uses, config?: 'ok'|'missing'|'invalid', paused?, modes?, hooks?: [{ file, problem }],
//           ledger?: { ok, reason }, listed?: [{ project, verdict, reasons, hidden? }], dev?: [...], reportPath? }
// Sections in the spec's order: alerts, MISS, RESTART, CLEAN, GB freed; dangling hook files; damaged ledger; listed stacks;
// dev servers.
export function renderReport(state = {}) {
  const now = toMs(state.now ?? Date.now());
  const s = outcomeSummary(state.decisions, state.uses, now);
  const head = [
    ...alertLines(state.decisions, null),
    ...(state.config && state.config !== 'ok' ? [`- NOT CONFIGURED (config.json ${state.config}): nothing is assessed or stopped; registration only records`] : []),
    ...(state.paused ? ['- PAUSED (pause file present): nothing is stopped'] : []),
    `- ${missHeadline(s)}`,
    `- RESTART ${s.restart} (cost only; the data was kept)`,
    `- CLEAN ${s.clean}${s.pending ? ` (+${s.pending} still inside the 2 h window)` : ''}`,
    `- GB freed ${s.gbFreed.toFixed(2)} (memory of the containers that would have been stopped, last 7 days)`,
    `- Switch-on: ${switchOn(s)}`,
    ...(isObject(state.modes) ? [`- Modes: ${Object.entries(state.modes).map(([k, v]) => `${k}=${v}`).join(', ')}`] : []),
  ];
  const out = ['# Stack stop report', '', `Generated ${when(now)}. Outcomes cover the last 7 days.`, '', '## Headlines', ...head, ''];
  out.push(...outcomeSection('MISS — a live consumer the checks missed', s.rows, 'MISS', 'none'));
  out.push(...outcomeSection('UNKNOWN — identity unreadable or never observed (counts as MISS until explained)', s.rows, 'UNKNOWN', 'none'));
  out.push(...outcomeSection('RESTART — used again after the would-stop (cost only)', s.rows, 'RESTART', 'none'));
  const clean = s.rows.filter((r) => r.outcome === 'CLEAN');
  out.push('## CLEAN — unused for 2 h after the would-stop', ...(clean.length ? clean.map((r) => `- ${oneLine(r.project)} — would-stop ${r.t}, unused for ${r.cleanDays} day(s)${r.memBytes ? `, ${(r.memBytes / GIB).toFixed(2)} GB` : ''}`) : ['none']), '');
  if (Array.isArray(state.hooks)) {
    out.push('## Installed hook files', ...(state.hooks.length ? state.hooks.map((h) => `- ${oneLine(h.file, 200)}: ${oneLine(h.problem, 80)}`) : ['all present']), '');
  }
  if (state.ledger && state.ledger.ok === false) {
    out.push('## Ledger damaged', `- ${oneLine(state.ledger.reason, 240)}`, '- Stopping is disabled until the ledger is repaired. Run `P stacks repair` (owner-run): it moves the bad lines to `ledger.bad.jsonl`.', '');
  }
  if (Array.isArray(state.listed)) {
    out.push('## Stacks listed for the owner', ...(state.listed.length ? state.listed.map(listedLine) : ['none']), '');
  }
  if (Array.isArray(state.dev)) {
    out.push('## Dev servers', ...(state.dev.length ? state.dev.map(devLine) : ['none']), '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// The section for the weekly worktree report (no top heading: the report's include supplies it). Last 7 days only.
export function renderWeekly(state = {}) {
  const now = toMs(state.now ?? Date.now());
  const s = outcomeSummary(state.decisions, state.uses, now);
  const stopped = s.rows.filter((r) => r.action === 'stopped').length;
  const orphans = (state.dev ?? []).filter((d) => d.verdict === 'orphan candidate');
  const alerts = alertLines(state.decisions, now - WEEK_MS);
  const out = [
    `Last 7 days (as of ${when(now)}):`,
    `- would-stops / stops: ${s.rows.length} (${stopped} stopped, ${s.rows.length - stopped} report-only)`,
    `- ${missHeadline(s)}; RESTART ${s.restart}; CLEAN ${s.clean}${s.pending ? ` (+${s.pending} pending)` : ''}`,
    `- memory that would be freed: ${s.gbFreed.toFixed(2)} GB`,
    ...alerts,
    ...(s.rows.length ? ['- stacks:', ...s.rows.map((r) => `  - ${oneLine(r.project)} ${r.action} ${r.t}: ${r.outcome}`)] : []),
    ...(Array.isArray(state.listed) && state.listed.length ? ['- listed stacks:', ...state.listed.map((l) => `  ${listedLine(l)}`)] : []),
    ...(orphans.length ? ['- dev orphan candidates:', ...orphans.map((d) => `  ${devLine(d)}`)] : []),
    ...(state.reportPath ? [`- full sweep report: ${state.reportPath}`] : []),
  ];
  return `${out.join('\n')}\n`;
}
