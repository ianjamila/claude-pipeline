// "Is a Claude Code session OPEN in this worktree right now?" for `pipeline worktrees prune`, however long it has sat idle
// (claude-pipeline #115). A session's own process keeps the folder it started in (usually ~); only its Bash shell moves into a
// worktree, so lsof sees nothing there, and once the session has been idle past `min_idle_hours` its transcript is too old for
// transcriptMentions. Claude Code itself says which sessions are open: it writes <config>/sessions/<pid>.json for each
// (pinned fields: pid, sessionId, procStart, cwd = the START folder). A record counts only while its pid is alive AND the
// process started when `procStart` says (pid reuse). The session's working folder is the `cwd` of the LAST line of its
// transcript <config>/projects/*/<sessionId>.jsonl; no transcript yet -> the record's start folder.
//
// Fail-closed, like the rest of this module: anything that stops us placing an open session (a record or transcript we cannot
// read, ps failing, a start-time format we do not recognise) lands in `unplaced`, and the run treats that as "in use" for EVERY
// candidate. Only "this machine has no sessions/ folder at all" (an older Claude Code, another tool, Windows) is `available:
// false`: the signal is an extra, never a requirement, so prune falls back to its other checks.
// Reads only (fs + one `ps`); the decision lives in rules.mjs, the re-check right before removal in act.mjs.
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '../paths.mjs';
import { unFirm } from './inspect.mjs';

// `procStart` and `ps -o lstart=` both read like "Thu Oct 29 08:54:42 2026"; Claude Code writes it in UTC.
const START_SHAPE = /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // goes into a file name: nothing that could climb out of projects/
const PS_TIMEOUT_MS = 30_000;
const FIRST_WINDOW = 1 << 20;
const MAX_WINDOW = 1 << 28; // a last `cwd` further back than this is "cannot place", not a 512 MB string
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const oneLine = (err) => String(err?.message ?? err).replace(/\s*\n\s*/g, ' ').trim().slice(0, 160);
// An absolute path of either flavour (posix `/x`, or a Windows drive path): a cwd that is anything else is not a place.
const isAbs = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p));
const goneCode = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

// $CLAUDE_CONFIG_DIR plus every <home>/.claude* directory, de-duplicated by realpath (the same set defaultTranscriptDirs
// reads, but by config dir: two accounts share projects/ through a symlink yet each has its own sessions/). Only "is not
// there" (ENOENT/ENOTDIR) is absence; any other failure to list the home or resolve a candidate (EACCES, ELOOP, EIO, ...) means
// a config dir may exist that we cannot look into, so it is pushed onto `problems` for the caller to treat as unplaced.
export function claudeConfigDirs(home = os.homedir(), env = process.env, problems = []) {
  let named = [];
  try {
    named = readdirSync(home).filter((n) => /^\.claude/.test(n)).sort();
  } catch (err) {
    if (!goneCode(err)) problems.push(`cannot list ${home} (${err?.code ?? oneLine(err)})`);
  }
  const wanted = [env.CLAUDE_CONFIG_DIR && path.resolve(env.CLAUDE_CONFIG_DIR), ...named.map((n) => path.join(home, n))];
  const seen = new Set();
  const dirs = [];
  for (const dir of wanted.filter(Boolean)) {
    let real;
    try {
      real = realpathSync(dir);
      if (!statSync(real).isDirectory()) continue; // ~/.claude.json and its backups
    } catch (err) {
      if (!goneCode(err)) problems.push(`cannot resolve ${dir} (${err?.code ?? oneLine(err)})`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    dirs.push(dir);
  }
  return dirs;
}

// The ps answer for `pids`: Map<pid, start time as ps prints it> for those running, or null when ps could not be asked or
// answered something unreadable. ps exits 1 with no output when none of the pids runs; procps also exits 1 WITH rows when only
// some are missing, so the rows are read whatever 0 or 1 it exits with. The environment is minimal and fixed: UTC is what
// `procStart` is written in, and the C locale pins the date format. `run` is a test seam.
const PS_ENV = Object.freeze({ PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' });
function runPs(args) {
  const r = spawnSync('ps', args, { encoding: 'utf8', env: PS_ENV, timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true });
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? '' };
}
export function psStarts(pids, run = runPs) {
  if (pids.length === 0) return new Map();
  const r = run(['-o', 'pid=,lstart=', '-p', pids.join(',')]);
  if (!r || r.error || r.signal || (r.status !== 0 && r.status !== 1)) return null;
  const out = new Map();
  for (const line of String(r.stdout ?? '').split('\n').filter((l) => l.trim())) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) return null;
    out.set(Number(m[1]), norm(m[2]));
  }
  // exit 1 and nothing printed: none of them runs. Exit 0 and nothing printed is not an answer.
  return out.size === 0 && r.status !== 1 ? null : out;
}

// The `cwd` of the last transcript line that has one, reading from the end with a window that grows (1 MB, x4) until one is
// found: a transcript can be tens of MB and its last line is where the session is now. null: the file has no cwd at all.
// Throws when the file cannot be read, or the last cwd lies further back than MAX_WINDOW.
export function lastCwd(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let win = FIRST_WINDOW; ; win *= 4) {
      const len = Math.min(win, size);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, size - len + got);
        if (n === 0) break;
        got += n;
      }
      const lines = buf.subarray(0, got).toString('utf8').split('\n');
      if (len < size) lines.shift(); // the first piece may be a cut line; the next, larger window reads it whole
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('"cwd"')) continue;
        try {
          const o = JSON.parse(lines[i]);
          if (isAbs(o?.cwd)) return o.cwd;
        } catch { /* a line still being written, or not JSON: look further back */ }
      }
      if (len >= size) return null;
      if (win >= MAX_WINDOW) throw new Error(`no cwd in the last ${MAX_WINDOW >> 20} MiB`);
    }
  } finally {
    closeSync(fd);
  }
}

// Does `file` exist? ENOENT/ENOTDIR -> false; any other failure (EACCES on a parent, ...) throws: not known to be absent.
function exists(file) {
  try {
    statSync(file);
    return true;
  } catch (err) {
    if (goneCode(err)) return false;
    throw err;
  }
}

// <projects>/<project>/<sessionId>.jsonl: the folder Claude names after the start cwd first, then every project folder.
function findTranscript(projects, session) {
  const guess = path.join(projects, String(session.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`);
  if (exists(guess)) return guess;
  let names;
  try {
    names = readdirSync(projects);
  } catch (err) {
    if (goneCode(err)) return null;
    throw err;
  }
  for (const name of names) {
    const file = path.join(projects, name, `${session.sessionId}.jsonl`);
    if (exists(file)) return file;
  }
  return null;
}

// Where one open session is: the last cwd of its transcript, else the record's start folder; [] when neither is known. A
// session is listed in the config dir of the account that runs it, but two accounts may list the same one and the first one
// scanned may hold no transcript, so EVERY config dir's projects/ is searched (own first; a projects/ shared through a symlink
// is looked at once). When several hold one, ALL their last cwds are returned and any of them inside a worktree keeps it:
// modification times cannot pick the live one (an idle session's files are all static, and a copy of a transcript is newer
// than the original), so only "any of them" cannot fail open. Throws when a transcript that exists cannot be read.
function placeSession(rec, configs) {
  const cwds = [];
  const looked = new Set();
  for (const config of [rec.config, ...configs.filter((c) => c !== rec.config)]) {
    let projects;
    try {
      projects = realpathSync(path.join(config, 'projects'));
    } catch (err) {
      if (goneCode(err)) continue;
      throw err;
    }
    if (looked.has(projects)) continue;
    looked.add(projects);
    const transcript = findTranscript(projects, rec);
    if (transcript === null) continue;
    let cwd = null;
    try {
      cwd = lastCwd(transcript);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err; // (gone since it was found: as if there were none)
    }
    if (cwd !== null && !cwds.includes(cwd)) cwds.push(cwd);
  }
  if (cwds.length) return cwds;
  return isAbs(rec.cwd) ? [rec.cwd] : [];
}

// -> { records: [{ pid, sessionId, cwd, procStart, config }], unplaced: string[], sawDir } from every <config>/sessions/<pid>.json.
// A record that vanished while we read (the session ended) is fine; one we cannot read or parse is not.
function readRecords(configs) {
  const records = [];
  const unplaced = [];
  let sawDir = false;
  for (const config of configs) {
    const dir = path.join(config, 'sessions');
    let names;
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (goneCode(err)) continue;
      sawDir = true;
      unplaced.push(`cannot read ${dir} (${err?.code ?? oneLine(err)})`);
      continue;
    }
    sawDir = true;
    for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
      const file = path.join(dir, name);
      let rec;
      try {
        rec = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        if (err?.code === 'ENOENT') continue; // the session ended between the listing and the read
        unplaced.push(`session record ${file} is unreadable (${err instanceof SyntaxError ? 'not JSON' : err?.code ?? oneLine(err)})`);
        continue;
      }
      if (!rec || typeof rec !== 'object' || !Number.isSafeInteger(rec.pid) || rec.pid <= 0 || typeof rec.sessionId !== 'string' || !SESSION_ID.test(rec.sessionId)) {
        unplaced.push(`session record ${file} has no usable pid / sessionId`);
        continue;
      }
      records.push({ pid: rec.pid, sessionId: rec.sessionId, cwd: rec.cwd, procStart: rec.procStart, config });
    }
  }
  return { records, unplaced, sawDir };
}

// Every open Claude Code session and where it is now. -> { available: false, reason } | { available: true, sessions:
// [{ id (first 8 of the session id), pid, cwd }], unplaced: [reason, ...] } (a session whose transcripts disagree has one entry
// per cwd). Never throws. Options (all test seams):
// `home`/`env` pick the config dirs, `platform` gates ps (only macOS and Linux have it; processesInside is "unavailable"
// elsewhere too), `starts(pids)` replaces the ps call (-> Map<pid, start> | null).
export function scanLiveSessions({ home = os.homedir(), env = process.env, platform = process.platform, starts = psStarts } = {}) {
  try {
    if (platform !== 'darwin' && platform !== 'linux') return { available: false, reason: `not supported on ${platform}` };
    const problems = [];
    const configs = claudeConfigDirs(home, env, problems);
    const { records, unplaced, sawDir } = readRecords(configs);
    unplaced.unshift(...problems); // a config dir we could not look into: the scan is partial, so it is not "unavailable"
    if (!sawDir && problems.length === 0) return { available: false, reason: 'no Claude sessions folder found' };
    const running = records.length ? starts([...new Set(records.map((r) => r.pid))]) : new Map();
    if (running === null || running === undefined) {
      unplaced.push('ps failed, so open Claude sessions cannot be told apart from finished ones');
      return { available: true, sessions: [], unplaced };
    }
    // One stale record (a reused pid) is normal; every running pid disagreeing means procStart changed format.
    const alive = records.filter((r) => running.has(r.pid) && r.procStart);
    if (new Set(alive.map((r) => r.pid)).size >= 2 && alive.every((r) => norm(r.procStart) !== running.get(r.pid))) {
      unplaced.push(`no session's procStart matches ps (e.g. "${norm(alive[0].procStart).slice(0, 40)}" vs "${running.get(alive[0].pid)}"): format changed?`);
      return { available: true, sessions: [], unplaced };
    }
    const sessions = [];
    const seen = new Set();
    for (const rec of records) {
      const start = running.get(rec.pid);
      if (start === undefined || seen.has(rec.sessionId)) continue;
      const label = `open session ${rec.sessionId.slice(0, 8)} pid ${rec.pid}`;
      if (rec.procStart !== undefined && rec.procStart !== null && rec.procStart !== '') {
        // A start time in a shape ps does not use cannot be compared: a lone session would look like a reused pid.
        if (typeof rec.procStart !== 'string' || !START_SHAPE.test(norm(rec.procStart))) {
          unplaced.push(`${label}: procStart is in an unrecognised format`);
          seen.add(rec.sessionId);
          continue;
        }
        if (norm(rec.procStart) !== start) continue; // the pid now belongs to another process
      }
      seen.add(rec.sessionId); // both accounts list a session they share: count it once
      try {
        const cwds = placeSession(rec, configs);
        if (cwds.length === 0) unplaced.push(`${label}: working folder unknown`);
        for (const cwd of cwds) sessions.push({ id: rec.sessionId.slice(0, 8), pid: rec.pid, cwd });
      } catch (err) {
        unplaced.push(`${label}: transcript unreadable (${err?.code ?? oneLine(err)})`);
      }
    }
    return { available: true, sessions, unplaced };
  } catch (err) {
    return { available: true, sessions: [], unplaced: [`scanning Claude sessions failed: ${oneLine(err)}`] };
  }
}

// What a scan means for one worktree. `spellings` = every way the worktree's path may be written (pathSpellings, taken while
// the worktree is still where it was). A session is in it when its working folder, as logged or resolved through symlinks,
// equals or lies below one of them (case rules as isInside: folded on macOS and Windows).
// -> { hits: [{ id, pid }], unplaced: string[] }. An unavailable scan says nothing.
export function liveSessionsIn(scan, spellings) {
  if (!scan?.available) return { hits: [], unplaced: [] };
  const roots = spellings.map(unFirm);
  const forms = (cwd) => {
    let real = cwd;
    try {
      real = realpathSync(cwd);
    } catch { /* gone, or not readable: only the logged spelling */ }
    return [...new Set([cwd, real].map(unFirm))];
  };
  const hits = [];
  for (const s of scan.sessions) {
    if (forms(s.cwd).some((c) => roots.some((r) => isInside(c, r))) && !hits.some((h) => h.id === s.id && h.pid === s.pid)) hits.push({ id: s.id, pid: s.pid });
  }
  return { hits, unplaced: scan.unplaced ?? [] };
}
