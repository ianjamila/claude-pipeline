// Writing the run record from the commands that own a stretch of the run (checkpoint, merge, update-branch). The record
// is display + routing hints, never a safety check: a failure to read or write it is a WARNING the caller reports in its
// own JSON, and must never change what the command decides.
// One thing the run carries for the merge gate: "resumed" (a run taken over from an earlier session needs the owner's word, and an unreadable
// record needs it too). The DURABLE evidence is the append-only `run-resumed` event (run-events.mjs: its own never-edited comment, which no record
// write can erase); `record.resumed` is a convenience copy of it. The record is one editable comment and GitHub has no conditional edit, so a
// read-then-write here is NOT atomic: re-reading right before the write (writeRunRecord) only narrows the window in which a concurrent writer's
// mark could be overwritten, and the merge gate reads the events too (resumedRunState). A record from a newer CLI is never overwritten.
import { hostname } from 'node:os';
import { applyCheckpoint, bindRecord, emptyRecord } from './run-record.mjs';
import { postEvent, readResumedEvidence } from './run-events.mjs';
import { readSummaryComment, writeSummaryComment } from './summary-comment.mjs';

export const VIEW_FIELDS = Object.freeze(['headRefOid', 'headRefName', 'baseRefName']);

// The record to build on: the one in the summary comment when it is readable and belongs to this PR, else a fresh one
// (with a warning when a record existed but was not usable). `existing` is a readSummaryComment result.
// An INVALID record may have been a resumed one, so its replacement is stamped `resumed` {at, host, head} (head: the PR head the caller
// knows, else ''): `P merge` keeps asking for the owner's word. An UNSUPPORTED record (a newer CLI wrote it) is never replaced: this throws.
export function baseRecordFor(existing, { repo, pr, branch, baseRef, step = 'build', host = hostname(), now = Date.now(), head = '' }) {
  const warnings = [];
  let resumed;
  if (existing.status === 'unsupported') throw new Error(UNSUPPORTED);
  if (existing.status === 'ok') {
    const mismatch = bindRecord(existing.record, { repo, pr, branch });
    if (mismatch.length === 0) return { record: existing.record, warnings };
    warnings.push(`the existing run record does not belong to this PR (${mismatch.join('; ')}); started a new one`);
  } else if (existing.status === 'invalid') {
    resumed = stampResumed({ host, now, head });
    warnings.push("the existing run record could not be read; started a new one, marked resumed (the merge then needs the owner's word)");
  }
  return { record: { ...emptyRecord({ repo, pr, branch, baseRef }), step, ...(resumed ? { resumed } : {}) }, warnings };
}

const UNSUPPORTED = 'the summary comment carries a run record from a newer pipeline version: update the pipeline CLI first';
const stampResumed = ({ host, now, head }) => ({ at: new Date(now).toISOString(), host: String(host ?? ''), head: String(head ?? '') });

// The ONE guarded writer of a run record (the recorder, `P checkpoint`, `P summary` and `P comment --kind summary` all use it). It
// re-reads the summary comment right before writing, because the record the caller built may rest on an older read. This narrows the window,
// it is not atomic (the PATCH below is unconditional): the durable evidence of a resumed run is the `run-resumed` event, not this copy.
//  - a record from a newer CLI appeared meanwhile: refuse (throws), never overwrite it;
//  - the fresh record is ok and `resumed` and `record` lacks the mark: carry it over. Bound to this PR or not: the comment IS this PR's summary,
//    the one the merge gate reads, so a repo / branch rename must not clear the mark;
//  - the fresh record is unreadable (invalid): mark the replacement resumed (fail closed, same as baseRecordFor) and, best effort, also post the
//    run-resumed event (a failure is reported to `onWarning`; the record mark still covers it). `skipResumedEvent`: the caller posted it already.
// The fresh read also supplies the kept sections.
export function writeRunRecord(gh, pr, { record, sections, host = hostname(), now = Date.now(), onWarning = () => {}, skipResumedEvent = false }) {
  const fresh = readSummaryComment(gh, pr);
  if (fresh.status === 'unsupported') throw new Error(UNSUPPORTED);
  let out = record;
  if (!out.resumed) {
    if (fresh.status === 'ok' && fresh.record.resumed) out = { ...out, resumed: fresh.record.resumed };
    else if (fresh.status === 'invalid') out = { ...out, resumed: stampResumed({ host, now, head: out.head }) };
  }
  if (fresh.status === 'invalid' && !skipResumedEvent) {
    try {
      postResumedEvent(gh, pr, out.resumed);
    } catch (err) {
      onWarning(`run-resumed event not posted: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  return writeSummaryComment(gh, pr, { record: out, sections, existing: fresh });
}

// The append-only evidence that this run was resumed: one new comment, never edited. Throws when it cannot be posted.
export const postResumedEvent = (gh, pr, { at, host, head }) => postEvent(
  gh, pr, 'run-resumed', `pr${pr}-${String(head || 'unknown').slice(0, 12)}-${Date.parse(at) || 0}`,
  'This run was taken over from an earlier session: the owner must say "merge" for it.', { at, host, head },
);

// What the merge gate reads about "was this run resumed": { existing (the record read, or null), resumed, unchecked }.
// resumed: the record carries the mark OR a viewer-authored run-resumed event exists (any head; a resumed run stays resumed): the event survives a
// record overwritten by a writer that had not seen the mark. unchecked (a reason): the record or the events cannot be read, so the answer is
// unknown and the gate must fail CLOSED. No record (absent) or a legacy comment is an ordinary run.
export function resumedRunState(gh, pr) {
  let existing = null;
  let unchecked = null;
  try {
    existing = readSummaryComment(gh, pr);
    if (existing.status === 'invalid' || existing.status === 'unsupported') unchecked = `the run record is ${existing.status}`;
  } catch (err) {
    unchecked = `the run record could not be read (${String(err?.message ?? err).slice(0, 200)})`;
  }
  const events = readResumedEvidence(gh, pr);
  if (events.unreadable !== null) unchecked ??= events.unreadable;
  return { existing, resumed: (existing?.status === 'ok' && Boolean(existing.record.resumed)) || events.resumed, unchecked };
}

// One recorder per command run. update(patch) never throws: it returns the new record, or null with a warning.
export function createRunRecorder({ gh, pr, host = hostname(), now = () => Date.now() }) {
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  let view = null;
  return {
    warnings,
    host,
    // `initialStep`: the step a brand-new record starts at (an existing record keeps its own unless the patch sets it).
    update(patch, { initialStep = 'build' } = {}) {
      try {
        const existing = readSummaryComment(gh, pr);
        view ??= gh.prView(pr, [...VIEW_FIELDS]);
        const repo = gh.repo().slug;
        const base = baseRecordFor(existing, { repo, pr, branch: view.headRefName, baseRef: view.baseRefName, step: initialStep, host, now: now(), head: view.headRefOid });
        base.warnings.forEach(warn);
        const record = applyCheckpoint(base.record, patch, { host, now: now() });
        const posted = writeRunRecord(gh, pr, { record, host, now: now(), onWarning: warn });
        return posted.record;
      } catch (err) {
        warn(`run record not updated: ${String(err?.message ?? err).slice(0, 200)}`);
        return null;
      }
    },
  };
}

export const inFlightSince = (recorder, kind, maxMinutes, now = Date.now()) => ({
  kind, host: recorder.host, startedAt: new Date(now).toISOString(), maxMinutes,
});
