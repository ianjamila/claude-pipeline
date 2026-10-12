// What one PR's comment list says, read the way every pipeline reader must read it: only comments the viewer wrote that
// START with our marker count. Shared by `P resume` (list + plan); `P inbox` carries its own copy of the same reading
// (commands/inbox.mjs) until it is moved onto this module.
import { MARKERS, line } from './render.mjs';
import { followupsPending } from './review-context.mjs';
import { bindRecord } from './run-record.mjs';
import { listEvents } from './run-events.mjs';
import { decodeFromComment } from './state.mjs';
import { summaryFromComments } from './summary-comment.mjs';
import { roundOutcome } from './triage.mjs';

// The newest comment the viewer wrote that STARTS with `marker` (a quoted or foreign marker is not ours).
export function newestMine(comments, viewer, marker) {
  return comments
    .filter((c) => typeof c.body === 'string' && c.body.startsWith(marker) && c.user?.login === viewer)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .at(-1) ?? null;
}

// Review facts from a decoded review state. `clean` is judged on the items alone (the content check is the router's own
// reason, from the live hash), so a PR without git facts is not called "not clean" for it. A round is complete when
// every item has its final decision.
export function triageFacts(state) {
  const last = state.rounds.at(-1);
  const lastContentHash = typeof last?.contentHashAtToHead === 'string' && last.contentHashAtToHead !== '' ? last.contentHashAtToHead : null;
  const outcome = roundOutcome({ ...state, currentContentHash: lastContentHash });
  return {
    rounds: state.rounds.length,
    lastRound: last?.n ?? 0,
    lastRoundComplete: last === undefined ? false : (last.items ?? []).every((i) => i.final !== undefined && i.final !== null),
    clean: outcome.clean,
    lastContentHash,
    followupsPending: followupsPending(state),
    needsHumanItems: outcome.needsHuman,
  };
}

// Our needs-human comment: the stated reason (first sentence) and how many hard-stop hits (`- rule — file` lines) it lists.
export function readNeedsHuman(comment) {
  if (!comment) return null;
  const body = comment.body.slice(MARKERS.needsHuman.length);
  const m = /stopped for a human decision: (.*?)\. Verified:/s.exec(body) ?? /stopped for a human decision: (.*?)(?:\.\s|\n|$)/s.exec(body);
  const hits = body.split('\n').filter((l) => l.startsWith('- ')).length;
  return { reason: m ? line(m[1], 200) : null, hits };
}

// -> { record (bound to this PR) | null, recordStatus, triage | null, needsHumanReason, events }. Problems go to `warnings`.
export function analyseComments(comments, viewer, { repo, pr, branch }, warnings = []) {
  const summary = summaryFromComments(comments, viewer);
  let recordStatus = summary.status;
  let record = summary.status === 'ok' ? summary.record : null;
  if (record) {
    const mismatch = bindRecord(record, { repo, pr, branch });
    if (mismatch.length > 0) {
      warnings.push(`#${pr}: the run record belongs to another PR or branch (${mismatch[0]}); ignored`);
      recordStatus = 'mismatch';
      record = null;
    }
  }
  if (recordStatus === 'unsupported' || recordStatus === 'invalid') warnings.push(`#${pr}: the run record could not be read (${recordStatus})`);

  let state = null;
  const triageComment = newestMine(comments, viewer, MARKERS.triage);
  if (triageComment) {
    state = decodeFromComment(triageComment.body);
    if (!state || state.pr !== pr) {
      if (state) warnings.push(`#${pr}: the review state comment belongs to PR ${state.pr}; ignored`);
      else warnings.push(`#${pr}: the review state comment could not be decoded; treated as no review`);
      state = null;
    }
  }

  const needsHuman = readNeedsHuman(newestMine(comments, viewer, MARKERS.needsHuman));
  return {
    record, recordStatus,
    triage: state ? triageFacts(state) : null,
    needsHumanReason: needsHuman?.reason ?? null,
    events: listEvents(comments, viewer),
  };
}
