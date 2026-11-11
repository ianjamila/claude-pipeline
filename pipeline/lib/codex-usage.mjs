// How much Codex the pipeline spends: one JSON line per real Codex run (a review round or a second review), appended to
//   <accountHome>/.claude/pipeline-state/codex-usage.jsonl
// and read back as a 7-day figure for the agent-log line (`pipeline summary`). The owner's Codex quota is weekly and shared by every
// repository on the machine, so the ledger is per account, not per repo. It is a statistic, never a gate: a write that fails is a
// warning (recordCodexRun returns it, never throws) and a missing, torn or hand-edited file reads as "nothing recorded".
//
// Line shape: {v:1, ts, kind:'review'|'second-review', repo (lower case owner/name), pr, round, effort, model, ok, resolutionOnly?}
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { accountHome } from './paths.mjs';
import { seamValue } from './seams.mjs';

export const USAGE_FILE_REL = ['.claude', 'pipeline-state', 'codex-usage.jsonl'];
export const USAGE_DAYS = 7;
// A ledger line is ~150 bytes; reading only the newest MAX_READ_BYTES keeps a runaway file from slowing every summary.
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = DAY_MS; // a clock a day ahead is skew; further ahead is not a run that happened
const OPEN_APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The ledger file. `file` (injected) wins, then $PIPELINE_CODEX_USAGE_FILE (a repo checkout only, like the other test seams: an installed
// copy ignores it), then the account's folder (`home` defaults to accountHome(), never $HOME).
export function usageFile({ file, home, env } = {}) {
  if (file) return path.resolve(file);
  const override = seamValue('PIPELINE_CODEX_USAGE_FILE', env);
  if (override) return path.resolve(override);
  return path.join(home ?? accountHome(), ...USAGE_FILE_REL);
}

// Every folder from `from` down to `dir` must be a real directory (a symlink would move the ledger elsewhere); missing ones are made.
function ensureRealDirs(from, dir) {
  const rel = path.relative(from, dir);
  let p = from;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return false;
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
      mkdirSync(p, { mode: 0o700 });
      if (!lstatSync(p).isDirectory()) return false;
    }
  }
  return true;
}

// Appends one run to the ledger. -> {ok:true} or {ok:false, warning}. Never throws.
export function recordCodexRun(run, { file, home, env, now = Date.now } = {}) {
  try {
    const target = usageFile({ file, home, env });
    const dir = path.dirname(target);
    const standard = !file && target === path.join(home ?? accountHome(), ...USAGE_FILE_REL);
    if (standard) {
      if (!ensureRealDirs(home ?? accountHome(), dir)) throw new Error(`${dir} is not a real directory`);
    } else {
      mkdirSync(dir, { recursive: true });
      if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    }
    try {
      if (!lstatSync(target).isFile()) throw new Error(`${target} is not a regular file`); // symlink, FIFO, device, directory
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const entry = {
      v: 1,
      ts: new Date(now()).toISOString(),
      kind: run.kind === 'second-review' ? 'second-review' : 'review',
      repo: typeof run.repo === 'string' && run.repo !== '' ? run.repo.toLowerCase() : null,
      pr: Number.isSafeInteger(run.pr) ? run.pr : null,
      round: Number.isSafeInteger(run.round) ? run.round : null,
      effort: String(run.effort ?? ''),
      model: String(run.model ?? ''),
      ok: run.ok === true,
      ...(run.resolutionOnly === true ? { resolutionOnly: true } : {}),
    };
    const fd = openSync(target, OPEN_APPEND, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`${target} is not a regular file`);
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, warning: `codex usage ledger not written: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// The text of the file's newest MAX_READ_BYTES (all of it when smaller), '' when there is no readable file.
function readTail(target) {
  let fd;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8');
    return st.size > len ? text.slice(text.indexOf('\n') + 1) : text; // a cut first line is torn: drop it
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

// The last `days` days of Codex runs, every repository: {runs, high, xhigh, failed}. `now` is ms. Lines that are not a ledger run
// (bad JSON, no usable timestamp, outside the window) are skipped.
export function codexUsage({ file, home, env, now = Date.now(), days = USAGE_DAYS } = {}) {
  const out = { runs: 0, high: 0, xhigh: 0, failed: 0 };
  const since = now - days * DAY_MS;
  for (const raw of readTail(usageFile({ file, home, env })).split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (!e || typeof e !== 'object' || typeof e.ts !== 'string') continue;
    const at = Date.parse(e.ts);
    if (Number.isNaN(at) || at < since || at > now + FUTURE_SLACK_MS) continue;
    out.runs += 1;
    if (e.effort === 'high') out.high += 1;
    else if (e.effort === 'xhigh') out.xhigh += 1;
    if (e.ok === false) out.failed += 1;
  }
  return out;
}

// ` · Codex 7d: N runs (H high[, X xhigh])` for the agent-log line, '' when nothing ran.
export function codexUsageSuffix(usage, days = USAGE_DAYS) {
  if (!usage || !(usage.runs > 0)) return '';
  const parts = [`${usage.high} high`];
  if (usage.xhigh > 0) parts.push(`${usage.xhigh} xhigh`);
  return ` · Codex ${days}d: ${usage.runs} run${usage.runs === 1 ? '' : 's'} (${parts.join(', ')})`;
}
