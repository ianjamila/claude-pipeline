// The needs-human hold that the owner's chat "merge" lifts (`P merge --owner-go`, plan 2026-11-05-chat-merge-protected, B and rev 4).
// Everything here reads GitHub only. A hold is the newest `labeled` needs-human event of the PR timeline: `{ id: node_id, login, at }`. It
// is ELIGIBLE (liftable by the owner's word) only when owner_approval is chat, needs-human is the only blocking label, and the timeline is
// complete and every labeled / unlabeled event in it is well-formed; anything unreadable is not eligible and the label stays a plain
// blocker. The pipeline never says whose hold it is (the account is shared); the owner is shown the machine-generated Hold block.
//
// withHoldLifted is the real run's lift, in order: re-read the timeline (the bound hold must still be the newest), post the append-only
// lift comment, install signal handlers, DELETE the label, post the append-only `hold-lift-deleted` marker comment, read the timeline again (it must show
// that marker, which makes the read at least as new as the delete, then exactly one needs-human removal before it and no newer hold), the plain blocker check, then the merge. Whenever nothing merged, the label is put back (a new hold: the owner says
// "merge" again) unless the PR is MERGED or someone else removed it; a run that exits WITHOUT its delete having taken effect posts an
// append-only `hold-lift-aborted` event so recovery never mistakes a later manual removal for its own. A lift comment with no label and
// no merge (the run was killed) is put right by recoverOrphanedLift. A signal kills the merge command's process group and disarms
// auto-merge BEFORE the label goes back, so a merge cannot land on a PR that has the hold again.
import { createHash } from 'node:crypto';
import { holdBlock } from '../hooks/lib/owner-go.mjs';
import { blockingLabelsOf, labelNames, validLabels } from './finalgate.mjs';
import { killTree } from './proc.mjs';
import { MARKERS } from './render.mjs';
import { parseEvent, postEvent } from './run-events.mjs';

export const HOLD_LABEL = 'needs-human';
export const PARK_NOTE_LABEL = 'pipeline park note (agent-written)';
export const RESTORE_NOTE = 'a restore creates a new hold: the owner must say "merge" again';
// The delete follows the lift comment within seconds: an `unlabeled` event further out than this was somebody's manual removal, not ours.
export const LIFT_WINDOW_MS = 15 * 60_000;
const PR_VIEW = ['state', 'headRefOid', 'labels'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHold = (name) => typeof name === 'string' && name.toLowerCase() === HOLD_LABEL;
const msg = (err) => String(err?.message ?? err).slice(0, 200);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the timeline -------------------------------------------------------------------------------

// The labeled / unlabeled events of a timeline reply, or why it cannot be trusted. EVERY such event must be well-formed (node_id, created_at as
// GitHub spells it, actor.login, label.name): one broken event makes the whole read unusable, whichever label it is about.
export function parseTimeline(list) {
  if (!Array.isArray(list)) return { ok: false, why: 'the timeline reply is not a list' };
  const events = [];
  const comments = []; // the `commented` events (id = the comment's id): the ordering barrier of the post-delete read
  for (const [index, e] of list.entries()) {
    if (!isObject(e)) return { ok: false, why: `timeline entry ${index} is not an object` };
    if (e.event === 'commented' && (typeof e.id === 'number' || (typeof e.id === 'string' && e.id !== ''))) comments.push({ index, id: String(e.id) });
    if (e.event !== 'labeled' && e.event !== 'unlabeled') continue;
    if (typeof e.node_id !== 'string' || e.node_id === '' || typeof e.created_at !== 'string' || !ISO.test(e.created_at)
      || !isObject(e.actor) || typeof e.actor.login !== 'string' || e.actor.login === '' || !isObject(e.label) || typeof e.label.name !== 'string') {
      return { ok: false, why: `a ${e.event} event in the timeline (entry ${index}) is malformed` };
    }
    events.push({ index, kind: e.event, id: e.node_id, at: e.created_at, login: e.actor.login, label: e.label.name });
  }
  return { ok: true, events, comments };
}

export function readTimeline(gh, pr) {
  let list;
  try {
    list = gh.timelineOf(pr);
  } catch (err) {
    return { ok: false, why: `the timeline could not be read (${msg(err)})` };
  }
  return parseTimeline(list);
}

const holdEvents = (events) => events.filter((e) => isHold(e.label));

// The newest needs-human `labeled` event: the last in the timeline's order, which must also carry the latest time (else the order is not trustworthy).
function newestHold(events) {
  const labeled = holdEvents(events).filter((e) => e.kind === 'labeled');
  const last = labeled.at(-1);
  if (!last || labeled.some((e) => e.at > last.at)) return null;
  return last;
}

const holdOf = (e) => ({ id: e.id, login: e.login, at: e.at });

// The label is on the PR now, according to the timeline: its newest needs-human event is a `labeled` one.
const appliedPer = (events) => holdEvents(events).at(-1)?.kind === 'labeled';

// ---- eligibility --------------------------------------------------------------------------------

// { hold, why }: the hold the owner's "merge" may lift, or null with the reason it may not. Never throws.
export async function readEligibleHold({ gh, pr, config }) {
  const none = (why) => ({ hold: null, why });
  try {
    if (config?.owner_approval !== 'chat') return none('owner_approval is not chat');
    const view = gh.prView(pr, ['state', 'headRefOid', 'labels']);
    if (!validLabels(view?.labels)) return none('the PR labels could not be read');
    if (!labelNames(view.labels).some(isHold)) return none('the PR has no needs-human label');
    const blocking = blockingLabelsOf(view.labels);
    if (!blocking.every(isHold)) return none(`another blocking label is on the PR (${blocking.filter((n) => !isHold(n)).join(', ')})`);
    const read = readTimeline(gh, pr);
    if (!read.ok) return none(read.why);
    if (!appliedPer(read.events)) return none('the timeline does not show needs-human as applied');
    const newest = newestHold(read.events);
    if (newest === null) return none('the timeline names no newest needs-human hold event');
    const hold = holdOf(newest);
    if (holdBlock(hold) === '') return none('the hold event cannot be shown as a Hold block');
    return { hold, why: null };
  } catch (err) {
    return none(`the hold could not be read (${msg(err)})`);
  }
}

// ---- the park note (rev 4 item 1) ---------------------------------------------------------------

// The newest needs-human park comment (P comment --kind needs-human upserts the viewer's own; it is written by the agent), shown only when it
// was last updated at or after the hold event, and always labelled as agent-written. null otherwise. Never throws.
export function parkNoteOf({ gh, pr, hold }) {
  try {
    const me = gh.viewer();
    const mine = gh.listComments(pr)
      .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.needsHuman) && c.user?.login === me)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const note = mine.at(-1);
    if (!note) return null;
    const updated = Date.parse(note.updated_at);
    const at = Date.parse(hold.at);
    if (!Number.isFinite(updated) || !Number.isFinite(at) || updated < at) return null;
    // One line, prefixed: whatever the agent wrote, no quoted line can start with Hold / Head / Areas / 🔀 and pass for part of the request.
    const oneLine = note.body.slice(MARKERS.needsHuman.length).replace(/\s+/g, ' ').trim().slice(0, 1500);
    return { label: PARK_NOTE_LABEL, updatedAt: note.updated_at, text: `quoted note: ${oneLine}` };
  } catch {
    return null;
  }
}

// ---- timing -------------------------------------------------------------------------------------

// The post-delete read retries 3 times, 2 s apart. PIPELINE_HOLD_RETRY_MS can only SHORTEN the pause (tests), never stretch it.
export function holdTiming(env = {}) {
  const ms = Number(env.PIPELINE_HOLD_RETRY_MS);
  return { retries: 3, pauseMs: Number.isInteger(ms) && ms >= 0 ? Math.min(ms, 2000) : 2000 };
}

// ---- signals ------------------------------------------------------------------------------------

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// While the label is off, a kill puts it back (synchronously: the process is about to go) and exits non-zero. Returns the function that removes the handlers.
export function installRestoreOnSignal({ restore, proc = process, exit = (code) => process.exit(code), write = (text) => process.stderr.write(text) }) {
  const handlers = Object.entries(SIGNAL_EXIT).map(([signal, code]) => {
    const handler = () => {
      let note = 'the needs-human hold was put back';
      try {
        restore();
      } catch (err) {
        note = `COULD NOT put the needs-human hold back (${msg(err)}): add the label by hand`;
      }
      try {
        write(`${signal}: ${note}\n`);
      } catch { /* the process is exiting anyway */ }
      exit(code);
    };
    proc.on(signal, handler);
    return [signal, handler];
  });
  return () => handlers.forEach(([signal, handler]) => proc.removeListener(signal, handler));
}

// ---- recovery (rev 4 item 4) --------------------------------------------------------------------

// A lift comment (ours, append-only) for the newest hold that is newer than that hold, with the PR open and the label gone: a run that lifted the hold died before
// it finished. { orphan: {hold} | null, unverified: why | null, commentsUnreadable?: true }. Reads comments first (or takes the list the caller read); the timeline and
// the PR only when a lift comment of ours exists. Fails closed: once a lift comment of ours is there, a timeline or PR that cannot be trusted is `unverified`, never "nothing".
// The lift counts only when (a) no abort event of ours for that hold follows it, and (b) the first `unlabeled` event after the hold came within LIFT_WINDOW_MS of it
// (a later one is somebody's manual removal).
export function findOrphanedLift({ gh, pr, comments: given }) {
  const nothing = { orphan: null, unverified: null };
  const unverified = (why, extra = {}) => ({ orphan: null, unverified: why, ...extra });
  let comments = given;
  if (comments === undefined) {
    try {
      comments = gh.listComments(pr);
    } catch (err) {
      return unverified(`the PR comments could not be read (${msg(err)})`, { commentsUnreadable: true });
    }
  }
  const events = comments.map((c, index) => ({ c, index, ev: parseEvent(c.body) })).filter(({ ev }) => ev?.dataStatus === 'ok' && typeof ev.data?.hold === 'string');
  const lifts = events.filter(({ ev }) => ev.kind === 'hold-lifted');
  if (lifts.length === 0) return nothing;
  try {
    const me = gh.viewer();
    const mine = (kind) => events.filter(({ c, ev }) => ev.kind === kind && c.user?.login === me);
    const ourLifts = mine('hold-lifted');
    if (ourLifts.length === 0) return nothing;
    const read = readTimeline(gh, pr);
    if (!read.ok) return unverified(read.why);
    const newest = newestHold(read.events);
    if (newest === null) return unverified('the timeline names no newest needs-human hold event, so the lift comment cannot be placed');
    const lifted = ourLifts.filter(({ c, ev }) => ev.data.hold === newest.id && typeof c.created_at === 'string' && c.created_at >= newest.at).at(-1);
    if (!lifted) return nothing;
    if (mine('hold-lift-aborted').some(({ index, ev }) => ev.data.hold === newest.id && index > lifted.index)) return nothing;
    const view = gh.prView(pr, PR_VIEW);
    if (!validLabels(view?.labels)) return unverified('the PR labels could not be read');
    if (view.state !== 'OPEN' || labelNames(view.labels).some(isHold)) return nothing;
    const bound = read.events.find((e) => e.kind === 'labeled' && isHold(e.label) && e.id === newest.id);
    const removal = holdEvents(read.events).find((e) => e.kind === 'unlabeled' && e.index > bound.index);
    if (!removal) return unverified('the timeline does not show who removed the label');
    const gap = Date.parse(removal.at) - Date.parse(lifted.c.created_at);
    if (!Number.isFinite(gap)) return unverified('the lift comment has no usable time');
    if (gap < 0 || gap > LIFT_WINDOW_MS) return nothing; // a manual removal, not our delete
    return { orphan: { hold: newest.id }, unverified: null };
  } catch (err) {
    return unverified(`the lift could not be checked (${msg(err)})`);
  }
}

// Put needs-human back after an orphaned lift. Returns null when done, else the reason it failed.
export function restoreLabel(gh, pr) {
  try {
    gh.addLabels(pr, [HOLD_LABEL]);
    return null;
  } catch (err) {
    return msg(err);
  }
}

// The real-run recovery: null (nothing to recover) or the refusal to return. `refuse` is the command's own.
// The comments are read twice at most (strict only; one pause, shortened by PIPELINE_HOLD_RETRY_MS). `strict` (--owner-go): comments that stay unreadable refuse (an
// interrupted lift cannot be ruled out). The gated route (strict false) tolerates ONLY a failed comments read (its run-record guard reads the same comments and fails closed by
// itself); a lift comment present with a timeline / PR that cannot be verified refuses in BOTH routes.
export async function recoverOrphanedLift({ gh, pr, refuse, strict = true, env = {}, sleep = defaultSleep }) {
  let comments;
  let readFailure = null;
  for (let attempt = 0; attempt < (strict ? 2 : 1); attempt += 1) {
    if (attempt > 0) await sleep(holdTiming(env).pauseMs);
    try {
      comments = gh.listComments(pr);
      readFailure = null;
      break;
    } catch (err) {
      readFailure = msg(err);
    }
  }
  if (readFailure !== null) {
    if (!strict) return null;
    return refuse('hold-recovery', [`#${pr}: PR comments unreadable, so an interrupted hold lift cannot be ruled out: run again (${readFailure}). Nothing was merged`]);
  }
  const { orphan, unverified } = findOrphanedLift({ gh, pr, comments });
  if (unverified !== null) return refuse('hold-recovery', [`#${pr}: could not check whether an earlier --owner-go run left a needs-human hold lifted (${unverified}): nothing was merged`]);
  if (orphan === null) return null;
  const failed = restoreLabel(gh, pr);
  if (failed !== null) {
    return refuse('hold-restore', [`COULD NOT put needs-human back on PR #${pr} (${failed}): an earlier --owner-go run lifted hold ${orphan.hold} and died. Add the label by hand; nothing was merged`], { holdRestored: false, holdRestoreFailed: true });
  }
  return refuse('hold-recovery', [`#${pr}: an earlier \`P merge --owner-go\` lifted needs-human hold ${orphan.hold} and died before it merged; the label is back on the PR. ${RESTORE_NOTE}. Nothing was merged`], { holdRestored: true, holdRestoredNote: RESTORE_NOTE });
}

// ---- the lift -----------------------------------------------------------------------------------

// After the delete: what the timeline says. 'newer' = a newer needs-human hold exists; 'ambiguous' = more than one removal before the marker (one is not ours to claim);
// 'ok' = the bound hold, then exactly one needs-human removal before THIS run's marker, nothing newer; 'pending' = the read is not yet as new as the delete: the marker comment
// (posted right after the delete, matched by the id the POST returned) is not in it, or the removal is not before it.
// Why the marker: any `unlabeled` event after the bound hold could be somebody else's. A read that shows the marker is at least as new as the delete, so the removals it shows
// before the marker are all there are, and exactly one of them is ours.
function judgeAfterDelete(read, hold, markerId) {
  const { events, comments } = read;
  const bound = events.find((e) => e.kind === 'labeled' && isHold(e.label) && e.id === hold.id);
  if (!bound) return { status: 'unreadable', why: 'the bound hold event is not in the timeline' };
  const newer = holdEvents(events).filter((e) => e.kind === 'labeled' && e.id !== hold.id && (e.index > bound.index || e.at > bound.at));
  if (newer.length > 0) return { status: 'newer', why: `a newer hold appeared (${newer.at(-1).id})` };
  const marker = comments.find((c) => c.id === markerId);
  if (!marker) return { status: 'pending', why: 'the timeline does not yet show this run\'s hold-lift-deleted marker comment, so the read may predate the delete' };
  const removals = holdEvents(events).filter((e) => e.kind === 'unlabeled' && e.index > bound.index && e.index < marker.index);
  if (removals.length > 1) return { status: 'ambiguous', why: `the timeline shows more than one needs-human removal after the hold (${removals.map((e) => e.id).join(', ')}), so this run's own cannot be told` };
  return removals.length === 1 ? { status: 'ok' } : { status: 'pending', why: 'the timeline does not show the removal of the label' };
}

// `check()` returns the problems that stop a merge once the hold is lifted (the plain rule); `merge()` returns the command's { exitCode, output };
// `refuse(error, reasons, extra)` is the command's own refusal. Returns the { exitCode, output } to give back.
// `merge(running)` gets `{ pid }` to fill with the merge command's process id (runShellAsync onStart) so a signal can kill that group; `kill(pid)` and
// `disableAuto()` (the synchronous disableAutoMerge) are what the signal handler runs, in that order, BEFORE the label goes back.
const liftId = (pr, hold) => `pr${pr}-${createHash('sha256').update(hold.id).digest('hex').slice(0, 16)}`;

// Best effort: tell recovery this run's lift did not take effect (or was not ours to undo), so a later manual removal is never "recovered".
function postAbort(gh, pr, hold, why) {
  try {
    postEvent(gh, pr, 'hold-lift-aborted', liftId(pr, hold), `hold ${hold.id} lift aborted: ${why}`, { pr, hold: hold.id, why });
    return true;
  } catch {
    return false;
  }
}

export async function withHoldLifted({ gh, pr, hold, head, items, repo, env = {}, sleep = defaultSleep, proc = process, exit, refuse, check, merge, kill = killTree, disableAuto = () => {} }) {
  const base = { head };
  // 2. Still the bound hold, still applied: nothing has changed yet, so a mismatch just refuses.
  const again = readTimeline(gh, pr);
  if (!again.ok) return refuse('hold', [`could not re-read the PR timeline before lifting the hold (${again.why}): nothing was changed`], base);
  const newest = newestHold(again.events);
  if (newest === null || newest.id !== hold.id || !appliedPer(again.events)) {
    return refuse('hold', [`the needs-human hold the owner approved (${hold.id}) is no longer the newest one on #${pr}${newest ? ` (now ${newest.id})` : ''}: show the new Hold block and ask the owner again. Nothing was changed`], base);
  }
  try {
    const view = gh.prView(pr, ['state', 'headRefOid', 'labels']);
    if (!validLabels(view?.labels) || !labelNames(view.labels).some(isHold)) {
      return refuse('hold', [`needs-human is no longer on #${pr}: nothing was changed`], base);
    }
  } catch (err) {
    return refuse('hold', [`could not re-read the PR labels before lifting the hold (${msg(err)}): nothing was changed`], base);
  }
  // 3. The append-only evidence comes first: if the run dies after the delete, it says which hold was lifted and for what.
  try {
    postEvent(gh, pr, 'hold-lifted', liftId(pr, hold),
      `hold ${hold.id} lifted on the owner's merge for head ${head.slice(0, 12)} items ${items}`, { repo, pr, head, items, hold: hold.id, login: hold.login, at: hold.at });
  } catch (err) {
    // (a POST that timed out may still have stored the comment: say it was not acted on)
    postAbort(gh, pr, hold, 'the lift comment could not be confirmed and the label was not touched');
    return refuse('hold', [`could not post the lift comment on #${pr} (${msg(err)}): the hold was not lifted`], base);
  }

  // From here the label may be gone: every way out that did not merge puts it back (unless the PR is MERGED, or someone else removed it).
  const restoreSync = () => {
    try {
      if (gh.prView(pr, PR_VIEW)?.state === 'MERGED') return;
    } catch { /* unreadable: put it back */ }
    gh.addLabels(pr, [HOLD_LABEL]);
  };
  // A signal: the merge command (and auto-merge) must be stopped BEFORE the label returns, else the PR could merge seconds later with the hold on.
  const running = { pid: undefined };
  const stopAndRestore = () => {
    try { kill(running.pid); } catch { /* the process is gone */ }
    try { disableAuto(); } catch { /* expected when auto-merge was never enabled */ }
    restoreSync();
  };
  const removeSignals = installRestoreOnSignal({ restore: stopAndRestore, proc, ...(exit ? { exit } : {}) });
  let result;
  let thrown;
  let threw = false;
  let removedByOther = false;
  try {
    // 4. DELETE; a failure may still have deleted (a timeout), so it is handled like every other exit below. A 404 is the exception: the label was not there
    // to delete, i.e. someone else removed it between the look and the delete; that is theirs to keep.
    let deleted = true;
    try {
      gh.deleteLabel(pr, HOLD_LABEL);
    } catch (err) {
      deleted = false;
      if (/\bHTTP 404\b/.test(msg(err))) {
        removedByOther = true;
        result = refuse('hold', [`the needs-human label was removed by someone else before this run's delete (${msg(err)}): it was not put back and nothing was merged`], { ...base, holdRemovedByOther: true });
      } else {
        result = refuse('hold', [`could not remove needs-human from #${pr} (${msg(err)}); the hold was not lifted`], base);
      }
    }
    // 4b. The ordering barrier: an append-only marker comment right after the delete. The post-delete read must show it (matched by the comment id the POST returned),
    // which proves that read is at least as new as the delete. Posting fails => the hold is put back, as for every other way out that did not merge.
    let markerId = null;
    let markerFailure = null;
    if (deleted) {
      try {
        const posted = postEvent(gh, pr, 'hold-lift-deleted', liftId(pr, hold), `hold ${hold.id} label deleted on the owner's merge`, { pr, hold: hold.id });
        markerId = posted?.id === undefined || posted?.id === null || posted.id === '' ? null : String(posted.id);
        if (markerId === null) markerFailure = 'the reply names no comment id';
      } catch (err) {
        markerFailure = msg(err);
      }
    }
    if (deleted && markerFailure !== null) {
      result = refuse('hold', [`could not post the delete marker comment on #${pr} (${markerFailure}): the hold was put back and nothing was merged`], base);
    } else if (deleted) {
      // 5. The proof the read is current: it shows the marker, exactly one removal of needs-human after the bound hold and before the marker, and no newer hold.
      const timing = holdTiming(env);
      let verdict = { status: 'unreadable', why: 'the timeline was not read' };
      for (let attempt = 0; attempt <= timing.retries; attempt += 1) {
        if (attempt > 0) await sleep(timing.pauseMs);
        const read = readTimeline(gh, pr);
        verdict = read.ok ? judgeAfterDelete(read, hold, markerId) : { status: 'unreadable', why: read.why };
        if (verdict.status === 'newer' || verdict.status === 'ambiguous' || verdict.status === 'ok') break;
      }
      if (verdict.status !== 'ok') {
        result = refuse('hold', [`${verdict.why}: the hold was put back and nothing was merged`], base);
      } else {
        // 6. The plain blocker rule from here (a needs-human re-added now is a blocker), then the merge.
        const problems = await check();
        result = problems.length > 0 ? refuse('pre-merge', problems, base) : await merge(running);
      }
    }
  } catch (err) {
    thrown = err;
    threw = true;
  }
  if (result?.output?.merged === true && !threw) {
    removeSignals();
    result.output.holdLifted = hold.id;
    return result;
  }
  // Someone else removed the label: not ours to put back. The abort event keeps recovery from reading their removal as this run's.
  if (removedByOther && !threw) {
    postAbort(gh, pr, hold, 'the label was removed by someone else before the delete');
    removeSignals();
    return result;
  }
  // Nothing merged (command failure, timeout, closed, blocked, a refusal, an exception): the hold comes back, after abandonMerge (merge() did that).
  const back = await putBack({ gh, pr, hold, env, sleep });
  if (back.status === 'kept' || back.status === 'unverified') postAbort(gh, pr, hold, back.status === 'kept' ? 'the label never left' : 'the label is on the PR but a new hold could not be confirmed');
  removeSignals();
  if (back.status === 'merged') {
    // The PR is MERGED after all (the command reported failure, or the wait ended first): the label stays off.
    return { exitCode: 0, output: { ok: true, merged: true, mergeSha: null, ...base, holdLifted: hold.id, warning: 'the PR is MERGED, seen after the merge attempt reported otherwise: resolve the merge SHA before anything depends on it' } };
  }
  if (back.status === 'failed') {
    return refuse('hold-restore', [`COULD NOT put needs-human back on PR #${pr} (${back.why}): the owner's merge lifted hold ${hold.id} and the PR did not merge. Add the label by hand${threw ? `; the run failed with: ${msg(thrown)}` : ''}`],
      { ...base, holdRestored: false, holdRestoreFailed: true });
  }
  const extra = {
    restored: { holdRestored: true, holdRestoredNote: RESTORE_NOTE },
    kept: { holdKept: true, holdKeptNote: 'the label never left the PR: the hold the owner approved is still the newest one' },
    unverified: { holdRestored: false, holdRestoreUnverified: true, holdRestoreNote: `needs-human is on the PR but whether it is a new hold could not be read (${back.why}): ask the owner to say "merge" again` },
  }[back.status];
  if (threw) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    error.message = `${error.message} (${back.status === 'restored' ? `needs-human was put back on #${pr}; ${RESTORE_NOTE}` : `needs-human is on #${pr}; ${extra.holdKeptNote ?? extra.holdRestoreNote}`})`;
    Object.assign(error, extra);
    throw error;
  }
  result.output = { ...result.output, ...extra };
  return result;
}

// The label goes back (read first: a label that is already on is not re-added) and the answer is what the timeline then shows:
// 'restored' = a NEW labeled needs-human event exists (only then is it "a new hold"), 'kept' = the old hold is still the newest (the label never left),
// 'unverified' = the label is on but the timeline could not be read, 'merged' = the PR is MERGED (nothing is put back), 'failed' = the label could not be added.
async function putBack({ gh, pr, hold, env, sleep }) {
  let view = null;
  try {
    view = gh.prView(pr, PR_VIEW);
  } catch { /* unreadable: put it back */ }
  if (view?.state === 'MERGED') return { status: 'merged' };
  let on = null;
  if (view && validLabels(view.labels)) on = labelNames(view.labels).some(isHold);
  if (on !== true) {
    try {
      gh.addLabels(pr, [HOLD_LABEL]);
    } catch (err) {
      return { status: 'failed', why: msg(err) };
    }
  }
  const timing = holdTiming(env);
  let seen = { status: 'unverified', why: 'the timeline was not read' };
  for (let attempt = 0; attempt <= (on !== true ? timing.retries : 0); attempt += 1) {
    if (attempt > 0) await sleep(timing.pauseMs);
    const read = readTimeline(gh, pr);
    if (!read.ok) {
      seen = { status: 'unverified', why: read.why };
      continue;
    }
    const newest = newestHold(read.events);
    if (newest !== null && newest.id !== hold.id && appliedPer(read.events)) return { status: 'restored' };
    seen = newest !== null && newest.id === hold.id ? { status: 'kept' } : { status: 'unverified', why: 'the timeline names no newest needs-human hold event' };
  }
  return seen;
}
