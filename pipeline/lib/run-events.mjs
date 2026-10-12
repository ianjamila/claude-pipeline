// Run events: append-only evidence that must outlive the editable run record (the rollback target, a rollback that
// began, the incident it opened). Each event is its OWN PR comment, created once and never edited, so no later writer
// can erase it. Only comments the viewer wrote that START with an event marker count; a quoted marker is not an event.
import { line } from './render.mjs';
import { packJson, unpackJson } from './run-record.mjs';

export const EVENT_KINDS = Object.freeze(['prod-before', 'rollback-intent', 'rollback-result', 'recovery-reported']);

const EVENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_START = /^<!-- claude-pipeline:event:([a-z-]+):([A-Za-z0-9._-]{1,64}) -->/;
const EVENT_DATA = /<!-- claude-pipeline:event-data:([A-Za-z0-9+/=]+) -->/g;

export function renderEvent(kind, id, sentence, data) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind ${JSON.stringify(kind)}`);
  if (!EVENT_ID.test(String(id))) throw new Error(`bad event id ${JSON.stringify(id)}: letters, digits, . _ - only`);
  return [
    `<!-- claude-pipeline:event:${kind}:${id} -->`,
    '',
    line(sentence, 300),
    '',
    `<!-- claude-pipeline:event-data:${packJson(data ?? {})} -->`,
  ].join('\n');
}

// null unless the body STARTS with an event marker of a known kind. dataStatus says whether the payload could be read.
export function parseEvent(body) {
  if (typeof body !== 'string') return null;
  const m = EVENT_START.exec(body);
  if (!m || !EVENT_KINDS.includes(m[1])) return null;
  const [kind, id] = [m[1], m[2]];
  const rest = body.slice(m[0].length);
  const cut = rest.indexOf('<!-- claude-pipeline:event-data:');
  const sentence = (cut < 0 ? rest : rest.slice(0, cut)).trim();
  const matches = [...body.matchAll(EVENT_DATA)];
  if (matches.length === 0) return { kind, id, sentence, data: null, dataStatus: 'absent' };
  try {
    return { kind, id, sentence, data: unpackJson(matches.at(-1)[1]), dataStatus: 'ok' };
  } catch {
    return { kind, id, sentence, data: null, dataStatus: 'invalid' };
  }
}

// The viewer's events, oldest comment first. `comments` is the full (paginated) list.
export function listEvents(comments, viewerLogin) {
  return comments
    .filter((c) => c?.user?.login === viewerLogin)
    .map((c) => ({ c, event: parseEvent(c.body) }))
    .filter((x) => x.event)
    .sort((a, b) => Number(a.c.id) - Number(b.c.id))
    .map(({ c, event }) => ({ commentId: c.id, url: c.html_url ?? null, ...event }));
}

// Rollback attempts whose `rollback-intent` has no `rollback-result` OF THE SAME ID (attempts are `<sha7>-<n>`, so an
// earlier attempt's result never closes a later attempt's intent). Oldest first. `mergeSha` narrows to one merge; an
// event whose payload cannot be read still counts, because it may be this merge's.
export function unresolvedRollbacks(events, { mergeSha = null } = {}) {
  const forMerge = (e) => !mergeSha || e.dataStatus !== 'ok' || e.data?.mergeSha === mergeSha;
  const done = new Set((events ?? []).filter((e) => e.kind === 'rollback-result' && forMerge(e)).map((e) => String(e.id)));
  return (events ?? []).filter((e) => e.kind === 'rollback-intent' && forMerge(e) && !done.has(String(e.id)));
}

export const readEvents = (gh, pr) => listEvents(gh.listComments(pr), gh.viewer());

// Always a new comment: this never calls upsertComment, so a second event can never rewrite a first one.
export function postEvent(gh, pr, kind, id, sentence, data) {
  return gh.createComment(pr, renderEvent(kind, id, sentence, data));
}
