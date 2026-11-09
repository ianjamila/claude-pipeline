// Repo moves: the owner's record that a GitHub repository was renamed or transferred (from -> to).
//
// Why: owner-go records (the owner's "merge", rulings, extra-round grants, consumed-grant markers) store the repository name as
// it was shown when the owner said it. After a transfer every check compares that stored name to repoKey(current origin), so
// grants made before the move no longer verified. The owner records the move once, in their own terminal
// (`pipeline repo-move`, commands/repo-move.mjs), into <home>/.claude/pipeline-state/owner-go/repo-moves.json, a file inside the
// folder guard-files protects (agents cannot write it). sameRepo then lets a record naming the OLD name count for the NEW one:
// one way only, and only for a record made BEFORE the move (a repository created later at the old name is a different repository).
// Fail closed: a missing, unreadable or in any way invalid file means no aliasing at all.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { accountHome } from '../../lib/paths.mjs';

// The same pattern owner-go.mjs matches a request's `repo` with (it imports it from here: this file imports nothing of owner-go, so there is no cycle).
export const REPO_NAME = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
// Same folder as owner-go.mjs OWNER_GO_REL (test/repo-moves.test.mjs holds the two equal).
export const REPO_MOVES_DIR_REL = '.claude/pipeline-state/owner-go';
export const REPO_MOVES_FILE = 'repo-moves.json';
export const MAX_MOVES_BYTES = 64 * 1024;
export const MAX_HOPS = 8;
export const REPO_MOVES_LOCK = `${REPO_MOVES_FILE}.lock`;

const NAME_RE = new RegExp(`^${REPO_NAME}$`);
export const repoMovesPath = (home = accountHome()) => path.join(home, ...REPO_MOVES_DIR_REL.split('/'), REPO_MOVES_FILE);

// 'ok' (every folder from <home>/.claude down is a real directory), 'missing' or 'unsafe' (a link, a file, unreadable).
function chainState(home, rel) {
  let p = home;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return 'unsafe';
    } catch (err) {
      return err?.code === 'ENOENT' ? 'missing' : 'unsafe';
    }
  }
  return 'ok';
}

// One entry of the file, normalised (names lower case), or null when it is not a valid move.
export function validMove(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (typeof m.from !== 'string' || typeof m.to !== 'string' || !NAME_RE.test(m.from) || !NAME_RE.test(m.to)) return null;
  const from = m.from.toLowerCase();
  const to = m.to.toLowerCase();
  if (from === to || typeof m.at !== 'string' || !Number.isFinite(Date.parse(m.at))) return null;
  if (!Number.isInteger(m.repoId) || m.repoId < 1) return null;
  return { from, to, at: m.at, repoId: m.repoId };
}

// { moves, error }: a missing file is { moves: [], error: null }. Anything else wrong (a linked folder or file, too big, not JSON, not
// version 1, ANY invalid entry) is { moves: [], error: <text> }: no aliasing at all. Never throws.
export function readRepoMoves({ home = accountHome() } = {}) {
  const none = (error) => ({ moves: [], error });
  const file = repoMovesPath(home);
  const chain = chainState(home, REPO_MOVES_DIR_REL);
  if (chain === 'missing') return none(null);
  if (chain === 'unsafe') return none(`${REPO_MOVES_DIR_REL} is not a real folder`);
  try {
    if (!lstatSync(file).isFile()) return none(`${file} is not a regular file`);
  } catch (err) {
    return err?.code === 'ENOENT' ? none(null) : none(`${file} cannot be read (${err?.code ?? 'error'})`);
  }
  let text;
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return none(`${file} is not a regular file`);
      if (st.size > MAX_MOVES_BYTES) return none(`${file} is larger than ${MAX_MOVES_BYTES} bytes`);
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return none(`${file} cannot be read (${err?.code ?? 'error'})`);
  }
  let data;
  try { data = JSON.parse(text); } catch { return none(`${file} is not valid JSON`); }
  if (data?.v !== 1 || !Array.isArray(data.moves)) return none(`${file} is not a version 1 repo-moves file`);
  const moves = [];
  for (const [i, m] of data.moves.entries()) {
    const ok = validMove(m);
    if (!ok) return none(`${file}: entry ${i} is not a valid move`);
    moves.push(ok);
  }
  return { moves, error: null };
}

// Does a record that names `recorded`, made at `recordedAt`, speak about `current`? Exact (case-insensitive) match, or a chain of moves
// from `recorded` to `current` where every hop was made AFTER the record (it predates that move). One way; at most MAX_HOPS hops; no name twice.
// One chain is ONE repository: every hop carries the same repoId and each hop is strictly later than the one before it (history is
// walked forwards, never back). A vacated name can be reused by another repository, so the chain is bound to the repository that held
// the recorded name at recordedAt: the EARLIEST move departing from that name after the record fixes the repoId (two departures at that
// same instant: unknown which repository, so no alias). Each later hop is likewise the earliest same-id departure from its name.
export function sameRepo({ recorded, recordedAt, current, moves } = {}) {
  if (typeof recorded !== 'string' || typeof current !== 'string') return false;
  const want = current.toLowerCase();
  const start = recorded.toLowerCase();
  if (start === want) return true;
  const madeAt = typeof recordedAt === 'string' ? Date.parse(recordedAt) : NaN;
  if (!Number.isFinite(madeAt) || !Array.isArray(moves)) return false;
  const later = moves.filter((m) => typeof m?.from === 'string' && typeof m.to === 'string' && Number.isInteger(m.repoId) && Date.parse(m.at) > madeAt)
    .map((m) => ({ from: m.from.toLowerCase(), to: m.to.toLowerCase(), at: Date.parse(m.at), repoId: m.repoId }));
  const earliest = (name, last, id) => {
    const out = later.filter((m) => m.from === name && m.at > last && (id === null || m.repoId === id));
    const t = Math.min(...out.map((m) => m.at));
    return out.filter((m) => m.at === t);
  };
  // `last` is the time of the previous hop (the record's own time for the first); `id` the chain's repository id.
  const walk = (name, seen, last, id) => {
    if (seen.size > MAX_HOPS) return false;
    return earliest(name, last, id).some((m) => !seen.has(m.to) && (m.to === want || walk(m.to, new Set([...seen, m.to]), m.at, id)));
  };
  const first = earliest(start, madeAt, null);
  if (first.length === 0 || first.some((m) => m.repoId !== first[0].repoId)) return false;
  return walk(start, new Set([start]), madeAt, first[0].repoId);
}

// The owner's writer (commands/repo-move.mjs). Appends `move` to the file, keeping every existing entry, with a temp file in the same
// folder (0600) renamed over it. Refuses when the existing file is invalid (the owner fixes or removes it) or the folder is not a real
// folder. A move with the same from, to AND time already present is a no-op (a later A -> B after B -> A is a new fact and is appended).
// Takes an exclusive lock file (repo-moves.json.lock, O_EXCL) around the read-validate-append-rename and refuses when it already exists (no waiting, no stealing). Returns { ok: true, added, moves } or { ok: false, reason }.
export function appendRepoMove(move, { home = accountHome() } = {}) {
  const entry = validMove(move);
  if (!entry) return { ok: false, reason: 'not a valid move (names owner/name, different from each other; a real time; a positive repository id)' };
  let p = home;
  for (const part of REPO_MOVES_DIR_REL.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return { ok: false, reason: `${p} is not a real folder` };
    } catch (err) {
      if (err?.code !== 'ENOENT') return { ok: false, reason: `${p} cannot be read (${err?.code ?? 'error'})` };
      try { mkdirSync(p, { mode: 0o700 }); } catch (e) { return { ok: false, reason: `cannot create ${p} (${e?.code ?? 'error'})` }; }
    }
  }
  const target = repoMovesPath(home);
  const lock = path.join(path.dirname(target), REPO_MOVES_LOCK);
  try {
    closeSync(openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
  } catch (err) {
    return { ok: false, reason: err?.code === 'EEXIST'
      ? `another repo-move is writing (or one died): ${lock} exists. Nothing was changed; remove that file if no repo-move is running, then try again`
      : `could not take the lock ${lock} (${err?.code ?? 'error'})` };
  }
  try {
    const existing = readRepoMoves({ home });
    if (existing.error) return { ok: false, reason: existing.error };
    if (existing.moves.some((m) => m.from === entry.from && m.to === entry.to && Date.parse(m.at) === Date.parse(entry.at))) return { ok: true, added: false, moves: existing.moves };
    const moves = [...existing.moves, entry];
    const temp = path.join(path.dirname(target), `.${REPO_MOVES_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ v: 1, moves }, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    } catch (err) {
      try { unlinkSync(temp); } catch { /* not created, or already renamed */ }
      return { ok: false, reason: `could not write ${target} (${err?.code ?? 'error'})` };
    }
    return { ok: true, added: true, moves };
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}
