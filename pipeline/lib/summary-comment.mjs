// The ONE writer of the PR's summary comment: marker + status block + summary sections + record marker.
// `P summary`, `P comment --kind summary` and `P checkpoint` all go through it, so whichever part the caller does not
// supply (the run record, or the summary sections) is kept from the comment already on the PR instead of being lost.
import { MARKERS } from './render.mjs';
import { STATUS_END, STATUS_START, decodeRecord, encodeRecord, renderStatusBlock } from './run-record.mjs';

const RECORD_MARKER_ANY = /<!-- claude-pipeline:record:[A-Za-z0-9+/=]+ -->/g;

// What is left of a summary body once the marker, the status block and the record marker are cut out.
export function sectionsOf(body) {
  let rest = String(body).slice(MARKERS.summary.length).replace(RECORD_MARKER_ANY, '').trimStart();
  if (rest.startsWith(STATUS_START)) {
    const end = rest.indexOf(STATUS_END);
    if (end >= 0) rest = rest.slice(end + STATUS_END.length);
  }
  return rest.trim();
}

// The newest summary comment the viewer wrote that STARTS with the marker: the same one upsertComment edits.
// -> {status: ok|absent|legacy|unsupported|invalid, record?, sections, url, id}
// `summaryFromComments` works on a comment list the caller already holds (`P inbox` reads each PR's list once).
export function summaryFromComments(comments, viewerLogin) {
  const mine = comments
    .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.summary) && c.user?.login === viewerLogin)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const found = mine.at(-1);
  if (!found) return { status: 'absent', sections: '', url: null, id: null };
  const decoded = decodeRecord(found.body);
  return { ...decoded, sections: sectionsOf(found.body), url: found.html_url ?? null, id: found.id };
}

export const readSummaryComment = (gh, pr) => summaryFromComments(gh.listComments(pr), gh.viewer());

// `record` / `sections` left undefined are kept from the existing comment; pass `existing` (a readSummaryComment result)
// to avoid reading it twice. An existing record this CLI cannot read (`unsupported`, newer version) is never dropped
// silently: omit `record` and the write is refused.
export function writeSummaryComment(gh, pr, { record, sections, existing } = {}) {
  const current = existing ?? readSummaryComment(gh, pr);
  if (record === undefined && current.status === 'unsupported') {
    throw new Error('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI before rewriting it');
  }
  const useRecord = record !== undefined ? record : (current.status === 'ok' ? current.record : null);
  const useSections = sections !== undefined ? sections : current.sections;
  const parts = [MARKERS.summary, ''];
  if (useRecord) parts.push(renderStatusBlock(useRecord), '');
  if (String(useSections).trim()) parts.push(String(useSections).trim(), '');
  if (useRecord) parts.push(encodeRecord(useRecord));
  const body = parts.join('\n').trimEnd();
  const posted = gh.upsertComment(pr, MARKERS.summary, body);
  return { ...posted, record: useRecord };
}
