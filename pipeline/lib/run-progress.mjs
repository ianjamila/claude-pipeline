// Writing the run record from the commands that own a stretch of the run (checkpoint, merge, update-branch). The record
// is display + routing hints, never a safety check: a failure to read or write it is a WARNING the caller reports in its
// own JSON, and must never change what the command decides.
// One thing the record does carry for the merge gate: `resumed` (a run taken over from an earlier session needs the owner's word, and an
// unreadable record needs it too). Replacing a record must therefore never DROP that state: an invalid record is replaced by one marked
// resumed, a record from a newer CLI is never overwritten, and every write goes through writeRunRecord, which re-reads right before writing.
import { hostname } from 'node:os';
import { applyCheckpoint, bindRecord, emptyRecord } from './run-record.mjs';
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
// re-reads the summary comment right before writing, because the record the caller built may rest on an older read:
//  - a record from a newer CLI appeared meanwhile: refuse (throws), never overwrite it;
//  - the fresh record (same PR) is `resumed` and `record` lacks the mark: carry it over, so a stale write cannot clear it;
//  - the fresh record is unreadable (invalid) and `record` lacks the mark: mark it resumed (fail closed, same as baseRecordFor).
// `repo` / `branch` bind the fresh record to this PR (left undefined = not checked). The fresh read also supplies the kept sections.
export function writeRunRecord(gh, pr, { record, sections, repo, branch, host = hostname(), now = Date.now() }) {
  const fresh = readSummaryComment(gh, pr);
  if (fresh.status === 'unsupported') throw new Error(UNSUPPORTED);
  let out = record;
  if (!out.resumed) {
    if (fresh.status === 'ok' && fresh.record.resumed && bindRecord(fresh.record, { repo, pr, branch }).length === 0) out = { ...out, resumed: fresh.record.resumed };
    else if (fresh.status === 'invalid') out = { ...out, resumed: stampResumed({ host, now, head: out.head }) };
  }
  return writeSummaryComment(gh, pr, { record: out, sections, existing: fresh });
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
        const posted = writeRunRecord(gh, pr, { record, repo, branch: view.headRefName, host, now: now() });
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
