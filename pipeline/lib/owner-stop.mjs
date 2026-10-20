// Owner stops (owner_approval: chat): a stop for the owner is an append-only `owner-stop` event on the PR (run-events.mjs), never
// a label. Events are the authority; the run record only carries a display copy. This file is the one creator (`openOwnerStop`)
// and the one reader (`ownerStopProblems`), plus the local pending file that keeps the PR blocked on THIS machine while the event
// has not reached GitHub (one file per stop id, written FIRST, before any GitHub call).
//
// Sequence (docs/plans/2026-10-20-chat-mode-no-needs-human.md, D1 + D4): resolve the repo from the local git remote (no network) ->
// mint an id and write the pending file -> take the per-repo+PR lock -> disarm auto-merge -> read events -> flush any OTHER pending
// file of this PR -> reuse an open stop or post ours -> delete our file (only after re-reading it and matching repo, pr and stop id).
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, UnavailableError } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { git } from './git.mjs';
import { parseRemote } from './notify.mjs';
import { withLock, LockTimeoutError } from './locks.mjs';
import { line } from './render.mjs';
import { openOwnerStops, postEvent, readEvents } from './run-events.mjs';
import { accountHome, realDirChain } from '../hooks/lib/owner-go.mjs';

export const OWNER_STOPS_REL = '.claude/pipeline-state/owner-stops';
export const STOP_ID_RE = /^[0-9a-f]{8}$/;
const CAUSE_RE = /^[A-Za-z0-9:_.-]{1,60}$/;
const NAME_PART = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_FILE_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 30_000;
export const DEFAULT_CAUSE = 'needs-human';

export const newStopId = () => randomBytes(4).toString('hex');
export const ownerStopsDir = (home = accountHome()) => path.join(home, ...OWNER_STOPS_REL.split('/'));
const lockDirOf = (home) => path.join(home, '.claude', 'pipeline-state', 'locks');

// ---- reply lines ------------------------------------------------------------------------------------------------------------

// The lines the controller prints verbatim when a run stops for the owner (`P summary`'s `reply`). The `Stopped` line carries the
// stop id the owner's release is bound to; with several open stops there is one line per id. A failed auto-merge disarm goes above.
export function stopReplyLines({ pr, ids, autoMergeDisarmed = true }) {
  const lines = [];
  if (autoMergeDisarmed === false) lines.push(`⚠ auto-merge could not be disarmed on #${pr}: run gh pr merge ${pr} --disable-auto`);
  for (const id of ids) lines.push(`Stopped #${pr} · stop ${id}`);
  lines.push(`⏸ Waiting on you for #${pr} — rule in chat, then say "ship resume ${pr}"`);
  return lines;
}

// ---- local identity + pending files -----------------------------------------------------------------------------------------

// owner/name from the LOCAL git remote (no network), or null (no remote, unparseable, or a name that cannot be a file name).
export function localRepoIdentity(root, deps = {}) {
  let url;
  try {
    url = deps.remoteUrl ? deps.remoteUrl(root) : git(['remote', 'get-url', 'origin'], { cwd: root }).trim();
  } catch {
    return null;
  }
  const r = parseRemote(url);
  if (!r || !NAME_PART.test(r.owner) || !NAME_PART.test(r.name)) return null;
  return { owner: r.owner, name: r.name, slug: r.slug };
}

const pendingPrefix = (id, pr) => `${id.owner}__${id.name}__${pr}__`;
const pendingName = (ident, pr, stopId) => `${pendingPrefix(ident, pr)}${stopId}.json`;
const lockNameOf = (ident, pr) => `owner-stop-${ident.owner}__${ident.name}__${pr}`;

const OPEN_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const OPEN_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

// Atomic: a temp file in the same folder, then rename. Throws on any failure (the caller maps it to stop-not-persisted).
function writePendingFile(home, ident, pr, record) {
  if (!realDirChain(home, OWNER_STOPS_REL)) throw new Error('the owner-stops folder is not a real directory');
  const dir = ownerStopsDir(home);
  const final = path.join(dir, pendingName(ident, pr, record.stop.id));
  const tmp = path.join(dir, `.${pendingName(ident, pr, record.stop.id)}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  const fd = openSync(tmp, OPEN_NEW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, final);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing left to clean */ }
    throw err;
  }
}

// -> {status:'ok', record} | {status:'invalid', why}. Never throws.
function readPendingFile(file) {
  try {
    if (!lstatSync(file).isFile()) return { status: 'invalid', why: 'not a regular file' };
    const fd = openSync(file, OPEN_READ);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return { status: 'invalid', why: 'not a regular file or too large' };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      const rec = JSON.parse(buf.subarray(0, off).toString('utf8'));
      const s = rec?.stop;
      if (rec?.v !== 1 || typeof rec.repo !== 'string' || !Number.isInteger(rec.pr) || rec.pr < 1
        || typeof s?.id !== 'string' || !STOP_ID_RE.test(s.id) || typeof s.at !== 'string'
        || (s.cause != null && !CAUSE_RE.test(String(s.cause))) || !['intent', 'unposted'].includes(rec.state)) {
        return { status: 'invalid', why: 'unexpected content' };
      }
      return { status: 'ok', record: rec };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { status: 'invalid', why: String(err?.message ?? err) };
  }
}

// Every pending file of this repo+PR. A file whose name fits but whose content cannot be read, or names another repo/PR/id, is
// reported as invalid (fail closed: it blocks until the owner looks). Oldest stop first.
function listPending(home, ident, pr) {
  const dir = ownerStopsDir(home);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    return [{ file: dir, id: null, invalid: `cannot list ${dir}: ${err.code ?? err.message}` }];
  }
  const re = new RegExp(`^${pendingPrefix(ident, pr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]{8})\\.json$`);
  const out = [];
  for (const name of names.sort()) {
    const m = re.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    const r = readPendingFile(file);
    if (r.status !== 'ok') out.push({ file, id: m[1], invalid: r.why });
    else if (r.record.repo !== ident.slug || r.record.pr !== pr || r.record.stop.id !== m[1]) out.push({ file, id: m[1], invalid: 'names another repo, PR or stop' });
    else out.push({ file, id: m[1], record: r.record });
  }
  return out.sort((a, b) => String(a.record?.stop.at ?? '').localeCompare(String(b.record?.stop.at ?? '')) || a.id.localeCompare(b.id));
}

// Deletes the file only after re-reading it and checking that repo, pr and stop id are the ones just confirmed on GitHub. Never a
// path-only unlink. true when the file is gone.
function deletePendingIfIdentity(file, { slug, pr, id }) {
  const r = readPendingFile(file);
  if (r.status !== 'ok' || r.record.repo !== slug || r.record.pr !== pr || r.record.stop.id !== id) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

const lockOpts = (home, deps) => ({ dir: lockDirOf(home), waitMs: LOCK_WAIT_MS, ...(deps.lock ?? {}) });
const homeOf = (deps) => deps.home ?? accountHome();

// ---- event data -------------------------------------------------------------------------------------------------------------

function stopEventData({ slug, pr, stop, host, autoMergeDisarmed }) {
  return { repo: slug, pr, id: stop.id, cause: stop.cause, head: stop.head ?? null, at: stop.at, host, autoMergeDisarmed: autoMergeDisarmed ?? null };
}

const stopSentence = (pr, id, cause) => `Owner stop ${id} on #${pr} (${cause}): only the owner's reply releases it.`;

function postStop(gh, pr, record) {
  const d = record.detail ?? {};
  return postEvent(gh, pr, 'owner-stop', record.stop.id, stopSentence(pr, record.stop.id, record.stop.cause ?? DEFAULT_CAUSE),
    stopEventData({ slug: record.repo, pr, stop: record.stop, host: d.host ?? os.hostname(), autoMergeDisarmed: d.autoMergeDisarmed }));
}

// ---- flush ------------------------------------------------------------------------------------------------------------------

// INSIDE the lock. For every pending file of this PR: an event with its id exists (open or released) => delete the file; else post it,
// then delete it. One file's failure never affects another. `events` is what the caller already read. Returns
// {events, posted: [ids], remaining: [{id, why}]}; `events` is re-read when something was posted.
function flushLocked({ gh, pr, home, ident, events, keep = null }) {
  const posted = [];
  const remaining = [];
  let known = events;
  for (const f of listPending(home, ident, pr)) {
    if (f.id === keep) continue;
    if (f.invalid) {
      remaining.push({ id: f.id, why: `unreadable pending stop file (${f.invalid})` });
      continue;
    }
    const target = { slug: ident.slug, pr, id: f.id };
    if (known.some((e) => e.kind === 'owner-stop' && String(e.id) === f.id)) {
      if (!deletePendingIfIdentity(f.file, target)) remaining.push({ id: f.id, why: 'could not remove the pending stop file' });
      continue;
    }
    try {
      postStop(gh, pr, f.record);
    } catch (err) {
      remaining.push({ id: f.id, why: `could not post the stop: ${String(err?.message ?? err).slice(0, 200)}` });
      continue;
    }
    posted.push(f.id);
    if (!deletePendingIfIdentity(f.file, target)) remaining.push({ id: f.id, why: 'posted, but could not remove the pending stop file' });
  }
  if (posted.length) {
    try {
      known = readEvents(gh, pr);
    } catch { /* the caller's own read decides */ }
  }
  return { events: known, posted, remaining };
}

// Posts the stops that never reached GitHub from this machine (or notes they already did) for this repo+PR. Serialized per repo+PR.
// Never throws; `ok` is false when something is still held locally. Not called by the read-only commands (`P resume plan|list`, `P inbox`).
export async function flushPendingStops({ gh, pr, root, deps = {} }) {
  const ident = localRepoIdentity(root, deps);
  if (!ident) return { ok: true, posted: [], remaining: [] };
  const home = homeOf(deps);
  if (listPending(home, ident, pr).length === 0) return { ok: true, posted: [], remaining: [] };
  try {
    return await withLock(lockNameOf(ident, pr), () => {
      const files = listPending(home, ident, pr);
      if (files.length === 0) return { ok: true, posted: [], remaining: [] };
      let events;
      try {
        events = readEvents(gh, pr);
      } catch (err) {
        return { ok: false, posted: [], remaining: files.map((f) => ({ id: f.id, why: `GitHub could not be read: ${String(err?.message ?? err).slice(0, 200)}` })) };
      }
      const r = flushLocked({ gh, pr, home, ident, events });
      return { ok: r.remaining.length === 0, posted: r.posted, remaining: r.remaining };
    }, lockOpts(home, deps));
  } catch (err) {
    const why = err instanceof LockTimeoutError ? 'the stop lock is busy' : String(err?.message ?? err).slice(0, 200);
    return { ok: false, posted: [], remaining: listPending(home, ident, pr).map((f) => ({ id: f.id, why })) };
  }
}

// Removes the pending file of ONE stop (identity-checked), under the same lock. Used when the owner's release is posted.
export async function removePendingStop({ pr, root, id, deps = {} }) {
  const ident = localRepoIdentity(root, deps);
  if (!ident) return false;
  const home = homeOf(deps);
  const mine = listPending(home, ident, pr).find((f) => f.id === id && f.record);
  if (!mine) return true;
  return withLock(lockNameOf(ident, pr), () => deletePendingIfIdentity(mine.file, { slug: ident.slug, pr, id }), lockOpts(home, deps));
}

// ---- open -------------------------------------------------------------------------------------------------------------------

// The only creator of an owner stop. Returns {id, ids, reused, stop:{id,cause,head,at}, autoMergeDisarmed, reply}.
// Throws Fail(1, stop-not-persisted) before anything is claimed when the stop cannot even be written locally, and UnavailableError
// (exit 3, `.stopId`, `.reply` set) when GitHub could not be reached: the pending file stays, so the PR is blocked on this machine.
export async function openOwnerStop({ gh, pr, root, cause = DEFAULT_CAUSE, head = null, env, deps = {} }) {
  const ident = localRepoIdentity(root, deps);
  if (!ident) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'stop-not-persisted', message: 'cannot record the owner stop: this checkout has no readable GitHub remote (git remote get-url origin), so the stop cannot be tracked' });
  }
  const home = homeOf(deps);
  const host = (deps.hostname ?? os.hostname)();
  const stop = { id: (deps.newId ?? newStopId)(), cause, head: /^[0-9a-f]{40}$/.test(String(head)) ? head : null, at: new Date((deps.now ?? Date.now)()).toISOString() };
  const base = { v: 1, repo: ident.slug, pr, stop, detail: { host, autoMergeDisarmed: null }, state: 'intent' };
  try {
    writePendingFile(home, ident, pr, base);
  } catch (err) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'stop-not-persisted', message: `cannot record the owner stop locally (${String(err?.message ?? err).slice(0, 160)}): fix the folder ~/${OWNER_STOPS_REL}, nothing was posted` });
  }
  const held = (why, ids = [stop.id], disarmed = null) => {
    const err = new UnavailableError(`${why}; owner stop ${stop.id} is held locally: P merge refuses until it reaches GitHub; tell the owner anyway`);
    err.stopId = stop.id;
    err.reply = stopReplyLines({ pr, ids, autoMergeDisarmed: disarmed }).join('\n');
    return err;
  };
  const markUnposted = (detail) => {
    try { writePendingFile(home, ident, pr, { ...base, detail, state: 'unposted' }); } catch { /* the file as first written still blocks */ }
  };

  // finalgate.mjs will import this file (T4), so its disarm helper is loaded lazily to keep the import graph acyclic.
  const disarm = deps.disableAutoMerge ?? (await import('./finalgate.mjs')).disableAutoMerge;
  let result;
  try {
    result = await withLock(lockNameOf(ident, pr), () => {
      // A queued merge must not fire on a stopped PR. A failure does not stop the sequence; the answer goes into the event.
      let disarmed = null;
      try {
        disarmed = disarm({ pr, cwd: root, env }) === true;
      } catch { /* unknown */ }
      const detail = { host, autoMergeDisarmed: disarmed };
      let events;
      try {
        events = readEvents(gh, pr);
      } catch (err) {
        markUnposted(detail);
        throw held(`GitHub could not be read (${String(err?.message ?? err).slice(0, 160)})`, [stop.id], disarmed);
      }
      const flushed = flushLocked({ gh, pr, home, ident, events, keep: stop.id });
      let open = openOwnerStops(flushed.events);
      const reused = open.length > 0;
      if (reused) {
        deletePendingIfIdentity(path.join(ownerStopsDir(home), pendingName(ident, pr, stop.id)), { slug: ident.slug, pr, id: stop.id });
      } else {
        try {
          postStop(gh, pr, { ...base, detail });
        } catch (err) {
          markUnposted(detail);
          throw held(`GitHub did not take the stop (${String(err?.message ?? err).slice(0, 160)})`, [stop.id], disarmed);
        }
        deletePendingIfIdentity(path.join(ownerStopsDir(home), pendingName(ident, pr, stop.id)), { slug: ident.slug, pr, id: stop.id });
        open = [...open, { id: stop.id, kind: 'owner-stop', dataStatus: 'ok', data: { cause: stop.cause, head: stop.head, at: stop.at } }];
      }
      return { open, reused, disarmed };
    }, lockOpts(home, deps));
  } catch (err) {
    if (err instanceof LockTimeoutError) throw held(`the stop lock is busy (${err.message.slice(0, 120)})`);
    throw err;
  }

  const ids = result.open.map((e) => String(e.id));
  const first = result.open[0];
  const d = first.dataStatus === 'ok' && first.data ? first.data : {};
  const copy = { id: String(first.id), cause: d.cause ?? null, head: d.head ?? null, at: typeof d.at === 'string' ? d.at : stop.at };
  return {
    id: copy.id, ids, reused: result.reused, stop: copy, autoMergeDisarmed: result.disarmed,
    reply: stopReplyLines({ pr, ids, autoMergeDisarmed: result.disarmed }).join('\n'),
  };
}

// ---- reader -----------------------------------------------------------------------------------------------------------------

// Why a merge on this PR must not go ahead because of an owner stop. [] in label mode, with NO gh call. Chat: a pending stop on this
// machine is flushed first (a failure is a problem); then the events are read (any read error is a problem: fail closed); every open
// stop is a problem naming its id and cause. The run record is never consulted. `autoMergeRequest` is the caller's `gh pr view`
// field (chat callers add it): armed auto-merge on a PR with an open stop is a problem too.
export async function ownerStopProblems({ gh, pr, root, ownerApproval, autoMergeRequest, deps = {} }) {
  if (ownerApproval !== 'chat') return [];
  const problems = [];
  const flush = await flushPendingStops({ gh, pr, root, deps });
  for (const r of flush.remaining) problems.push(`owner stop ${r.id ?? '?'} is held on this machine and has not reached GitHub (${r.why})`);
  let events;
  try {
    events = readEvents(gh, pr);
  } catch (err) {
    problems.push(`owner stops could not be read from GitHub (${String(err?.message ?? err).slice(0, 160)}): treated as open`);
    return problems;
  }
  const open = openOwnerStops(events);
  for (const e of open) {
    const cause = e.dataStatus === 'ok' && e.data?.cause ? e.data.cause : 'unreadable';
    problems.push(`owner stop ${line(e.id, 64)} (${line(cause, 60)}) is open (only the owner's reply releases it): say "ship resume ${pr}", or "merge" when offered`);
  }
  if (open.length && autoMergeRequest != null) problems.push(`auto-merge is armed on a stopped PR: gh pr merge ${pr} --disable-auto`);
  return problems;
}

