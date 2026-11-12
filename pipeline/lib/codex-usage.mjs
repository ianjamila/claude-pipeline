// How much of Codex's WEEKLY quota is used, when it resets, the last quota outage and the PRs waiting for Codex (plan 2026-11-11-codex-substitute-reviewer,
// B1 and R4-9). Two sources:
//   1. readWeeklyUsage(): Codex's own session logs, `<account home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Their `token_count` events carry
//      `payload.rate_limits = {limit_id, primary: {used_percent, window_minutes, resets_at}}` (Codex CLI 0.154). That is Codex's private log format, read
//      as best effort: anything that does not fit is ignored and the answer is `source: 'unknown'`. It never throws.
//   2. A machine-global record, `<account home>/.claude/pipeline-state/codex/status.json`, that the pipeline keeps: the last quota outage and the PRs
//      parked until Codex is back. Written under a lock (locks.mjs withLock, as the model floor registry is) with write-then-rename, so concurrent
//      sessions never lose each other's entries and a reader never sees half a file.
// Nothing in here decides a review; it only reports. Wiring into codex-review / review-complete / hooks is a later task.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withLock } from './locks.mjs';
import { accountHome } from './paths.mjs';
import { seamValue } from './seams.mjs';

// ---- the weekly figure, from Codex's session logs ------------------------------------------------------------------------------------------
export const WEEK_MINUTES = 10080;
// An observation older than this is not "how much is used now" (R4-9); one stamped further ahead than the skew allows is not trusted either.
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MAX_FUTURE_MS = 5 * 60 * 1000;
// Bounded scan: only the newest DAY_FOLDERS date folders (by name) are listed, and of the files in them only the newest MAX_FILES by mtime are read,
// each from its last TAIL_BYTES. A weekly figure older than 6 h is ignored anyway, so a deeper scan could never change the answer.
export const DAY_FOLDERS = 4;
export const MAX_FILES = 40;
export const TAIL_BYTES = 512 * 1024;

const UNKNOWN = Object.freeze({ weeklyUsedPct: null, windowMinutes: null, resetsAt: null, observedAt: null, source: 'unknown' });

const toMs = (now) => {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(ms) ? ms : Date.now();
};
const isoOf = (ms) => new Date(ms).toISOString();
const numericDirs = (dir, width) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && new RegExp(`^\\d{${width}}$`).test(d.name)).map((d) => d.name).sort().reverse();
  } catch {
    return [];
  }
};

// The newest `days` day folders under sessions/, newest first, as absolute paths (names sort chronologically: YYYY/MM/DD).
function newestDayFolders(sessions, days) {
  const out = [];
  for (const y of numericDirs(sessions, 4)) {
    for (const m of numericDirs(path.join(sessions, y), 2)) {
      for (const d of numericDirs(path.join(sessions, y, m), 2)) {
        out.push(path.join(sessions, y, m, d));
        if (out.length >= days) return out;
      }
    }
  }
  return out;
}

// The newest MAX_FILES rollout files by mtime (newest first), [{file, mtimeMs}].
function newestSessionFiles(sessions, { dayFolders = DAY_FOLDERS, maxFiles = MAX_FILES } = {}) {
  const files = [];
  for (const dir of newestDayFolders(sessions, dayFolders)) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = statSync(file);
        if (st.isFile()) files.push({ file, mtimeMs: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

// One event line -> an observation { usedPct, windowMinutes, resetsAtMs, atMs } or null when it is not a usable weekly `codex` reading right now.
function observationOf(event, nowMs) {
  if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return null;
  const limits = event.payload.rate_limits;
  if (limits?.limit_id !== 'codex') return null; // `premium` (a quota failure) and every other limit are not the weekly figure
  const p = limits.primary;
  if (p === null || typeof p !== 'object') return null; // `primary: null` is "no reading", never 0 %
  if (p.window_minutes !== WEEK_MINUTES) return null;
  if (typeof p.used_percent !== 'number' || !Number.isFinite(p.used_percent) || p.used_percent < 0) return null;
  const atMs = Date.parse(event.timestamp);
  if (!Number.isFinite(atMs) || atMs < nowMs - MAX_AGE_MS || atMs > nowMs + MAX_FUTURE_MS) return null;
  if (typeof p.resets_at !== 'number' || !Number.isFinite(p.resets_at)) return null;
  const resetsAtMs = p.resets_at * 1000; // epoch SECONDS in Codex's log
  if (resetsAtMs <= atMs || resetsAtMs <= nowMs) return null;
  return { usedPct: p.used_percent, windowMinutes: p.window_minutes, resetsAtMs, atMs };
}

// The newest valid observation in one file (by event timestamp), reading only its tail; null when there is none.
function newestObservationIn(file, nowMs) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (size > length) lines.shift(); // starts mid-line
    let best = null;
    for (const raw of lines) {
      const text = raw.trim();
      if (!text.startsWith('{') || !text.includes('token_count')) continue;
      let event;
      try { event = JSON.parse(text); } catch { continue; } // malformed line: skipped
      const o = observationOf(event, nowMs);
      if (o && (best === null || o.atMs > best.atMs)) best = o;
    }
    return best;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

// The folder the governor reads: the ACCOUNT's own Codex home (<accountHome()>/.codex, never $HOME), or null. $CODEX_HOME is caller-controlled: a log an agent
// writes anywhere it can and points CODEX_HOME at would fake "the weekly quota is spent" and so steer which reviewer a round gets. So a CODEX_HOME that names
// any other folder turns the governor OFF (null: the reading is unknown, Codex runs), it is never trusted. PIPELINE_CODEX_HOME (a test seam, honoured by a
// repo checkout only, seams.mjs) names a scratch home for the test suite.
export const PIPELINE_CODEX_HOME_ENV = 'PIPELINE_CODEX_HOME';
const same = (a, b) => {
  const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
};
export function governorCodexHome({ env = process.env, home } = {}) {
  const seam = seamValue(PIPELINE_CODEX_HOME_ENV, env);
  if (seam) return path.resolve(seam);
  const own = path.join(home ?? accountHome(), '.codex');
  const named = env?.CODEX_HOME;
  if (typeof named === 'string' && named.trim() !== '' && !same(named, own)) return null;
  return own;
}

// -> { weeklyUsedPct, windowMinutes, resetsAt (ISO), observedAt (ISO, the event's own time), source: 'codex-sessions' } or the same keys null with
// source 'unknown'. The newest event wins by its OWN timestamp across the scanned files (a newer-mtime file can hold an older event). Never throws.
export function readWeeklyUsage({ env = process.env, now = Date.now(), home, dayFolders, maxFiles } = {}) {
  try {
    const nowMs = toMs(now);
    const codexHome = governorCodexHome({ env, home });
    if (codexHome === null) return { ...UNKNOWN };
    const sessions = path.join(codexHome, 'sessions');
    let best = null;
    for (const { file } of newestSessionFiles(sessions, { dayFolders, maxFiles })) {
      const o = newestObservationIn(file, nowMs);
      if (o && (best === null || o.atMs > best.atMs)) best = o;
    }
    if (best === null) return { ...UNKNOWN };
    return { weeklyUsedPct: best.usedPct, windowMinutes: best.windowMinutes, resetsAt: isoOf(best.resetsAtMs), observedAt: isoOf(best.atMs), source: 'codex-sessions' };
  } catch {
    return { ...UNKNOWN };
  }
}

// ---- the machine-global record -------------------------------------------------------------------------------------------------------------
export const STATUS_FILE = 'status.json';
export const LOCK_NAME = 'codex-status';
export const LOCK_WAIT_MS = 30_000;
export const STATUS_DIR_ENV = 'PIPELINE_CODEX_STATUS_DIR';
const STATUS_REL = ['.claude', 'pipeline-state', 'codex'];

// `dir` (injected) wins; else $PIPELINE_CODEX_STATUS_DIR, honoured only by a repo checkout (seams.mjs: an installed copy ignores it); else the account's
// folder (accountHome(), never $HOME).
export function statusDir({ dir, home, env } = {}) {
  if (dir) return path.resolve(dir);
  const override = seamValue(STATUS_DIR_ENV, env);
  if (override) return path.resolve(override);
  return path.join(home ?? accountHome(), ...STATUS_REL);
}
export const statusFile = (opts) => path.join(statusDir(opts), STATUS_FILE);

const EMPTY = () => ({ version: 1, lastOutage: null, waiting: [] });
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const timeOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const stamp = (v, now) => timeOrNull(v instanceof Date ? v.toISOString() : v) ?? isoOf(toMs(now));

// The sentence a session reads to pick a parked PR back up.
export const resumePrompt = ({ repo, pr, round, worktree }) => `resume the review of ${repo}#${pr} from round ${round} in ${worktree}`;

function cleanOutage(o) {
  if (o === null || typeof o !== 'object') return null;
  const at = timeOrNull(o.at);
  if (at === null) return null;
  return { at, resetAt: timeOrNull(o.resetAt), resetText: text(o.resetText), repo: text(o.repo), pr: posInt(o.pr), round: posInt(o.round), worktree: text(o.worktree) };
}

function cleanWaiting(w) {
  if (w === null || typeof w !== 'object') return null;
  const repo = text(w.repo);
  const pr = posInt(w.pr);
  const round = posInt(w.round);
  const worktree = text(w.worktree);
  const since = timeOrNull(w.since);
  if (repo === null || pr === null || round === null || worktree === null || since === null) return null;
  return { repo, pr, round, worktree, since, resume: resumePrompt({ repo, pr, round, worktree }) };
}

// The record as it is on disk, tolerant: a missing, unreadable or odd file is the empty record, an odd entry is dropped. Never throws, takes no lock
// (a writer replaces the file by rename, so this always sees one whole version).
export function readStatus(opts = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(statusFile(opts), 'utf8'));
  } catch {
    return EMPTY();
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY();
  const waiting = [];
  for (const w of Array.isArray(raw.waiting) ? raw.waiting : []) {
    const c = cleanWaiting(w);
    if (c !== null && !waiting.some((x) => x.repo === c.repo && x.pr === c.pr)) waiting.push(c);
  }
  return { version: 1, lastOutage: cleanOutage(raw.lastOutage), waiting };
}

function writeStatusAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw err;
  }
}

// read-modify-write under the machine-wide lock. `change(status)` mutates the (cleaned) record; the new record is returned.
async function update(opts, change) {
  const dir = statusDir(opts);
  mkdirSync(dir, { recursive: true });
  return withLock(LOCK_NAME, () => {
    const status = readStatus(opts);
    change(status);
    writeStatusAtomic(path.join(dir, STATUS_FILE), status);
    return status;
  }, { dir, waitMs: opts.waitMs ?? LOCK_WAIT_MS, pollMs: opts.pollMs ?? 50 });
}

const need = (what, v) => { if (v === null) throw new TypeError(`codex status: ${what} is required`); return v; };

// A quota stop: {at, resetAt (ISO or null: unknown), resetText ("4:21 PM" as Codex said it, or null), repo, pr, round, worktree}. Replaces lastOutage.
export async function recordOutage({ at, resetAt, resetText, repo, pr, round, worktree, now } = {}, opts = {}) {
  const outage = { at: stamp(at, now), resetAt: timeOrNull(resetAt), resetText: text(resetText), repo: text(repo), pr: posInt(pr), round: posInt(round), worktree: text(worktree) };
  return update(opts, (s) => { s.lastOutage = outage; });
}

// The PR is parked until Codex is back. Upsert by (repo, pr): a second add updates round and worktree and keeps the earlier `since` unless one is given.
export async function addWaiting({ repo, pr, worktree, round, since, now } = {}, opts = {}) {
  const r = need('repo', text(repo));
  const n = need('pr (a positive integer)', posInt(pr));
  const w = need('worktree', text(worktree));
  const rd = need('round (a positive integer)', posInt(round));
  return update(opts, (s) => {
    s.waiting = s.waiting.filter((x) => (x.repo === r && x.pr === n) || !waitingStale(x, toMs(now)));
    const at = s.waiting.findIndex((x) => x.repo === r && x.pr === n);
    const kept = at >= 0 ? s.waiting[at].since : null;
    const entry = cleanWaiting({ repo: r, pr: n, worktree: w, round: rd, since: since === undefined ? (kept ?? isoOf(toMs(now))) : stamp(since, now) });
    if (at >= 0) s.waiting[at] = entry;
    else s.waiting.push(entry);
  });
}

// The PR is no longer waiting (reviewed, or Codex answered). Removing one that is not there changes nothing.
// Owner command (`codex-status --forget --pr N [--repo slug]`): drop the entries for a PR number (of one repo when given); -> how many were removed.
export async function forgetWaiting({ repo, pr } = {}, opts = {}) {
  const n = need('pr (a positive integer)', posInt(pr));
  const r = text(repo);
  let removed = 0;
  await update(opts, (s) => {
    const keep = s.waiting.filter((x) => !(x.pr === n && (r === null || x.repo === r)));
    removed = s.waiting.length - keep.length;
    s.waiting = keep;
  });
  return removed;
}

export async function removeWaiting({ repo, pr } = {}, opts = {}) {
  const r = need('repo', text(repo));
  const n = need('pr (a positive integer)', posInt(pr));
  return update(opts, (s) => { s.waiting = s.waiting.filter((x) => !(x.repo === r && x.pr === n)); });
}

// Codex answered: forget the last outage (the waiting list is kept: each PR is removed on its own).
export async function clearOutage(opts = {}) {
  return update(opts, (s) => { s.lastOutage = null; });
}

// ---- the whole picture ---------------------------------------------------------------------------------------------------------------------
export function codexStatus({ env = process.env, now = Date.now(), ...opts } = {}) {
  const usage = readWeeklyUsage({ env, now });
  const { lastOutage, waiting } = readStatus({ env, ...opts });
  return { ...usage, lastOutage, waiting };
}

// When Codex is back, in epoch ms: the latest of the outage's reset (an outage with no reset time counts for 2 h from `at`, R4-10) and, when the week
// is used up (>= 100 %), the weekly reset; null when nothing is out. Anything already past is not "out".
export const OUTAGE_NO_RESET_MS = 2 * 60 * 60 * 1000;
export function backAtMs(status, nowMs) {
  const times = [];
  const o = status.lastOutage;
  if (o) times.push(o.resetAt !== null ? Date.parse(o.resetAt) : Date.parse(o.at) + OUTAGE_NO_RESET_MS);
  if (typeof status.weeklyUsedPct === 'number' && status.weeklyUsedPct >= 100 && status.resetsAt) times.push(Date.parse(status.resetsAt));
  const future = times.filter((t) => Number.isFinite(t) && t > nowMs);
  return future.length === 0 ? null : Math.max(...future);
}

// ---- best-effort notes the commands make (a failure here is a warning, never a failed round) ---------------------------------------------------
// -> [warning text]. Neither throws.
// A quota stop: lastOutage = this stop, and the PR is parked until Codex is back (the resume prompt names the worktree).
export async function noteQuotaStop({ at, resetAt, resetText, repo, pr, round, worktree, now, env } = {}) {
  const warnings = [];
  try {
    await recordOutage({ at, resetAt, resetText, repo, pr, round, worktree, now }, { env });
  } catch (err) {
    warnings.push(`could not record the Codex outage: ${err.message}`);
  }
  try {
    await addWaiting({ repo, pr, worktree, round, since: at, now }, { env });
  } catch (err) {
    warnings.push(`could not record the PR as waiting for Codex: ${err.message}`);
  }
  return warnings;
}

// Codex answered a review for this PR: the PR is no longer waiting, and the last outage is over. Reads the record first (no lock, no file written) and
// does nothing when it holds nothing to clear. `repo` is a slug, or a function that gives one (null when unknown: the waiting entry is then left).
export async function noteCodexAnswered({ pr, repo, env } = {}) {
  const warnings = [];
  try {
    const status = readStatus({ env });
    const parked = status.waiting.some((w) => w.pr === pr);
    if (status.lastOutage === null && !parked) return warnings;
    if (parked) {
      const slug = typeof repo === 'function' ? repo() : repo;
      if (typeof slug === 'string' && slug !== '') await removeWaiting({ repo: slug, pr }, { env });
      else warnings.push('could not tell which repository the waiting PR belongs to; it stays in the Codex waiting list');
    }
    if (status.lastOutage !== null) await clearOutage({ env });
  } catch (err) {
    warnings.push(`could not update the Codex outage record: ${err.message}`);
  }
  return warnings;
}

// The PR was reviewed (review-complete posted the marker, by Codex or by a Claude stand-in): it is no longer waiting for Codex. Unlike noteCodexAnswered
// the last outage is left alone (a substitute round does not prove Codex is back). Best effort, never throws; reads first, so a PR that is not parked costs no write.
export async function noteReviewed({ pr, repo, env } = {}) {
  const warnings = [];
  try {
    if (!readStatus({ env }).waiting.some((w) => w.pr === pr)) return warnings;
    const slug = typeof repo === 'function' ? repo() : repo;
    if (typeof slug === 'string' && slug !== '') await removeWaiting({ repo: slug, pr }, { env });
    else warnings.push('could not tell which repository the waiting PR belongs to; it stays in the Codex waiting list');
  } catch (err) {
    warnings.push(`could not update the Codex waiting list: ${err.message}`);
  }
  return warnings;
}

// ---- the SessionStart notice (B2) ----------------------------------------------------------------------------------------------------------
// Lines for a session that starts while PRs wait for Codex and Codex is back (the outage's reset has passed): "Codex is back: <repo>#N (round R) ... waiting",
// then each entry's resume sentence. The record is agent-writable, so an entry whose repo or worktree is not a plain slug / absolute path is left out (never
// free text in a session's context). [] when nothing waits or Codex is still out.
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,2}$/;
const SAFE_PATH = /^(?:\/|[A-Za-z]:[\\/])[^\x00-\x1f\x7f\u2028\u2029]{0,300}$/;
// A parked PR whose worktree is gone, or that has waited longer than this, is not told to every new session for ever (R1-F3); `codex-status --forget --pr N` removes one by hand.
export const MAX_WAITING_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const waitingStale = (w, nowMs, exists = existsSync) => {
  const since = Date.parse(w?.since);
  return (Number.isFinite(since) && nowMs - since > MAX_WAITING_AGE_MS) || !exists(w?.worktree);
};
export function backNoticeLines(status, nowMs = Date.now()) {
  const waiting = (status?.waiting ?? []).filter((w) => SAFE_REPO.test(w.repo) && SAFE_PATH.test(w.worktree) && !waitingStale(w, nowMs));
  if (waiting.length === 0) return [];
  // the weekly figure is not read here (it scans session files): only the outage record decides, which is what holds a parked PR
  if (backAtMs({ lastOutage: status.lastOutage ?? null }, nowMs) !== null) return [];
  const names = waiting.map((w) => `${w.repo}#${w.pr} (round ${w.round})`).join(', ');
  return [`Codex is back: ${names} ${waiting.length === 1 ? 'is' : 'are'} waiting`, ...waiting.map((w) => `  ${resumePrompt(w)}`)];
}
