// Writing the run record from the commands that own a stretch of the run (checkpoint, merge, update-branch). The record
// is display + routing hints, never a safety check: a failure to read or write it is a WARNING the caller reports in its
// own JSON, and must never change what the command decides.
import { hostname } from 'node:os';
import { applyCheckpoint, bindRecord, emptyRecord } from './run-record.mjs';
import { readSummaryComment, writeSummaryComment } from './summary-comment.mjs';

export const VIEW_FIELDS = Object.freeze(['headRefOid', 'headRefName', 'baseRefName']);

// The record to build on: the one in the summary comment when it is readable and belongs to this PR, else a fresh one
// (with a warning when a record existed but was not usable). `existing` is a readSummaryComment result.
export function baseRecordFor(existing, { repo, pr, branch, baseRef, step = 'build' }) {
  const warnings = [];
  if (existing.status === 'ok') {
    const mismatch = bindRecord(existing.record, { repo, pr, branch });
    if (mismatch.length === 0) return { record: existing.record, warnings };
    warnings.push(`the existing run record does not belong to this PR (${mismatch.join('; ')}); started a new one`);
  } else if (existing.status === 'invalid') {
    warnings.push('the existing run record could not be read; started a new one');
  }
  return { record: { ...emptyRecord({ repo, pr, branch, baseRef }), step }, warnings };
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
        if (existing.status === 'unsupported') throw new Error('the summary comment carries a run record from a newer pipeline version');
        view ??= gh.prView(pr, [...VIEW_FIELDS]);
        const base = baseRecordFor(existing, {
          repo: gh.repo().slug, pr, branch: view.headRefName, baseRef: view.baseRefName, step: initialStep,
        });
        base.warnings.forEach(warn);
        const record = applyCheckpoint(base.record, patch, { host, now: now() });
        writeSummaryComment(gh, pr, { record, existing });
        return record;
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
