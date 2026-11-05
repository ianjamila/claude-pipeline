// The needs-human hold that the owner's chat "merge" lifts (`P merge --owner-go`, plan 2026-11-05-chat-merge-protected, B and rev 4).
// Everything here reads GitHub only. A hold is the newest `labeled` needs-human event of the PR timeline: `{ id: node_id, login, at }`. It
// is ELIGIBLE (liftable by the owner's word) only when owner_approval is chat, needs-human is the only blocking label, and the timeline is
// complete and every labeled / unlabeled event in it is well-formed; anything unreadable is not eligible and the label stays a plain
// blocker. The pipeline never says whose hold it is (the account is shared); the owner is shown the machine-generated Hold block.
//
// withHoldLifted is the real run's lift, in order: re-read the timeline (the bound hold must still be the newest), post the append-only
// lift comment, install signal handlers, DELETE the label, read the timeline again (it must show the delete's own `unlabeled` event and no
// newer hold), the plain blocker check, then the merge. Whenever nothing merged, the label is put back (a new hold: the owner says
// "merge" again). A lift comment with no label and no merge (the run was killed) is put right by recoverOrphanedLift.
import { createHash } from 'node:crypto';
import { holdBlock } from '../hooks/lib/owner-go.mjs';
import { blockingLabelsOf, labelNames, validLabels } from './finalgate.mjs';
import { MARKERS } from './render.mjs';
import { parseEvent, postEvent } from './run-events.mjs';

export const HOLD_LABEL = 'needs-human';
export const PARK_NOTE_LABEL = 'pipeline park note (agent-written)';
export const RESTORE_NOTE = 'a restore creates a new hold: the owner must say "merge" again';
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
  for (const [index, e] of list.entries()) {
    if (!isObject(e)) return { ok: false, why: `timeline entry ${index} is not an object` };
    if (e.event !== 'labeled' && e.event !== 'unlabeled') continue;
    if (typeof e.node_id !== 'string' || e.node_id === '' || typeof e.created_at !== 'string' || !ISO.test(e.created_at)
      || !isObject(e.actor) || typeof e.actor.login !== 'string' || e.actor.login === '' || !isObject(e.label) || typeof e.label.name !== 'string') {
      return { ok: false, why: `a ${e.event} event in the timeline (entry ${index}) is malformed` };
    }
    events.push({ index, kind: e.event, id: e.node_id, at: e.created_at, login: e.actor.login, label: e.label.name });
  }
  return { ok: true, events };
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
    return { label: PARK_NOTE_LABEL, updatedAt: note.updated_at, text: note.body.slice(MARKERS.needsHuman.length).trim().slice(0, 1500) };
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
// it finished. { orphan: {hold} | null, unverified: why | null }. Reads comments first; the timeline and the PR only when a lift comment exists.
export function findOrphanedLift({ gh, pr }) {
  const nothing = { orphan: null, unverified: null };
  const unverified = (why) => ({ orphan: null, unverified: why });
  let comments;
  try {
    comments = gh.listComments(pr);
  } catch (err) {
    return unverified(`the PR comments could not be read (${msg(err)})`);
  }
  const lifts = comments.map((c) => ({ c, ev: parseEvent(c.body) })).filter(({ ev }) => ev?.kind === 'hold-lifted' && ev.dataStatus === 'ok' && typeof ev.data?.hold === 'string');
  if (lifts.length === 0) return nothing;
  try {
    const me = gh.viewer();
    const mine = lifts.filter(({ c }) => c.user?.login === me);
    if (mine.length === 0) return nothing;
    const read = readTimeline(gh, pr);
    if (!read.ok) return unverified(read.why);
    const newest = newestHold(read.events);
    if (newest === null) return nothing;
    const lifted = mine.find(({ c, ev }) => ev.data.hold === newest.id && typeof c.created_at === 'string' && c.created_at >= newest.at);
    if (!lifted) return nothing;
    const view = gh.prView(pr, ['state', 'headRefOid', 'labels']);
    if (!validLabels(view?.labels)) return unverified('the PR labels could not be read');
    if (view.state !== 'OPEN' || labelNames(view.labels).some(isHold)) return nothing;
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
export function recoverOrphanedLift({ gh, pr, refuse }) {
  const { orphan, unverified } = findOrphanedLift({ gh, pr });
  if (unverified !== null) return refuse('hold-recovery', [`#${pr}: could not check whether an earlier --owner-go run left a needs-human hold lifted (${unverified}): nothing was merged`]);
  if (orphan === null) return null;
  const failed = restoreLabel(gh, pr);
  if (failed !== null) {
    return refuse('hold-restore', [`COULD NOT put needs-human back on PR #${pr} (${failed}): an earlier --owner-go run lifted hold ${orphan.hold} and died. Add the label by hand; nothing was merged`], { holdRestored: false, holdRestoreFailed: true });
  }
  return refuse('hold-recovery', [`#${pr}: an earlier \`P merge --owner-go\` lifted needs-human hold ${orphan.hold} and died before it merged; the label is back on the PR. ${RESTORE_NOTE}. Nothing was merged`], { holdRestored: true, holdRestoredNote: RESTORE_NOTE });
}

// ---- the lift -----------------------------------------------------------------------------------

// After the delete: what the timeline says. 'newer' = a newer needs-human hold exists; 'ok' = the bound hold, then this delete's own unlabeled event, nothing newer;
// 'pending' = the bound hold is there but the delete's event is not yet.
function judgeAfterDelete(events, hold) {
  const bound = events.find((e) => e.kind === 'labeled' && isHold(e.label) && e.id === hold.id);
  if (!bound) return { status: 'unreadable', why: 'the bound hold event is not in the timeline' };
  const newer = holdEvents(events).filter((e) => e.kind === 'labeled' && e.id !== hold.id && (e.index > bound.index || e.at > bound.at));
  if (newer.length > 0) return { status: 'newer', why: `a newer hold appeared (${newer.at(-1).id})` };
  const own = holdEvents(events).find((e) => e.kind === 'unlabeled' && e.index > bound.index);
  return own ? { status: 'ok' } : { status: 'pending', why: 'the timeline does not show the removal of the label' };
}

// `check()` returns the problems that stop a merge once the hold is lifted (the plain rule); `merge()` returns the command's { exitCode, output };
// `refuse(error, reasons, extra)` is the command's own refusal. Returns the { exitCode, output } to give back.
export async function withHoldLifted({ gh, pr, hold, head, items, repo, env = {}, sleep = defaultSleep, proc = process, exit, refuse, check, merge }) {
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
    postEvent(gh, pr, 'hold-lifted', `pr${pr}-${createHash('sha256').update(hold.id).digest('hex').slice(0, 16)}`,
      `hold ${hold.id} lifted on the owner's merge for head ${head.slice(0, 12)} items ${items}`, { repo, pr, head, items, hold: hold.id, login: hold.login, at: hold.at });
  } catch (err) {
    return refuse('hold', [`could not post the lift comment on #${pr} (${msg(err)}): the hold was not lifted`], base);
  }

  // From here the label may be gone: every way out that did not merge puts it back.
  const restoreSync = () => {
    try {
      if (gh.prView(pr, ['state'])?.state === 'MERGED') return;
    } catch { /* unreadable: put it back */ }
    gh.addLabels(pr, [HOLD_LABEL]);
  };
  const removeSignals = installRestoreOnSignal({ restore: restoreSync, proc, ...(exit ? { exit } : {}) });
  let result;
  let thrown = null;
  try {
    // 4. DELETE; a failure may still have deleted (a timeout), so it is handled like every other exit below.
    let deleted = true;
    try {
      gh.deleteLabel(pr, HOLD_LABEL);
    } catch (err) {
      deleted = false;
      result = refuse('hold', [`could not remove needs-human from #${pr} (${msg(err)}); the hold was not lifted`], base);
    }
    if (deleted) {
      // 5. The proof the read is current: this delete's own `unlabeled` event after the bound hold, and no newer hold.
      const timing = holdTiming(env);
      let verdict = { status: 'unreadable', why: 'the timeline was not read' };
      for (let attempt = 0; attempt <= timing.retries; attempt += 1) {
        if (attempt > 0) await sleep(timing.pauseMs);
        const read = readTimeline(gh, pr);
        verdict = read.ok ? judgeAfterDelete(read.events, hold) : { status: 'unreadable', why: read.why };
        if (verdict.status === 'newer' || verdict.status === 'ok') break;
      }
      if (verdict.status !== 'ok') {
        result = refuse('hold', [`${verdict.why}: the hold was put back and nothing was merged`], base);
      } else {
        // 6. The plain blocker rule from here (a needs-human re-added now is a blocker), then the merge.
        const problems = await check();
        result = problems.length > 0 ? refuse('pre-merge', problems, base) : await merge();
      }
    }
  } catch (err) {
    thrown = err;
  }
  if (result?.output?.merged === true) {
    removeSignals();
    result.output.holdLifted = hold.id;
    return result;
  }
  // Nothing merged (command failure, timeout, closed, blocked, a refusal, an exception): the hold comes back, after abandonMerge (merge() did that).
  let failed = null;
  try {
    gh.addLabels(pr, [HOLD_LABEL]);
  } catch (err) {
    failed = msg(err);
  }
  removeSignals();
  if (failed !== null) {
    return refuse('hold-restore', [`COULD NOT put needs-human back on PR #${pr} (${failed}): the owner's merge lifted hold ${hold.id} and the PR did not merge. Add the label by hand${thrown ? `; the run failed with: ${msg(thrown)}` : ''}`],
      { ...base, holdRestored: false, holdRestoreFailed: true });
  }
  if (thrown) {
    if (thrown instanceof Error) {
      thrown.message = `${thrown.message} (needs-human was put back on #${pr}; ${RESTORE_NOTE})`;
      thrown.holdRestored = true;
    }
    throw thrown;
  }
  result.output = { ...result.output, holdRestored: true, holdRestoredNote: RESTORE_NOTE };
  return result;
}
