// Run events: append-only evidence that must outlive the editable run record (the rollback target, a rollback that
// began, the incident it opened, and that a run was taken over from an earlier session: `run-resumed`, which the merge gate reads beside the run record). Each event is its OWN PR comment, created once and never edited, so no later writer
// can erase it. Only comments the viewer wrote that START with an event marker count; a quoted marker is not an event.
import { line } from './render.mjs';
import { packJson, unpackJson } from './run-record.mjs';

export const EVENT_KINDS = Object.freeze(['prod-before', 'rollback-intent', 'rollback-result', 'recovery-reported', 'ci-proof-used', 'hold-lifted', 'hold-lift-deleted', 'hold-lift-aborted', 'run-resumed']);

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

// Always a new comment: this never calls upsertComment, so a second event can never rewrite a first one.
export function postEvent(gh, pr, kind, id, sentence, data) {
  return gh.createComment(pr, renderEvent(kind, id, sentence, data));
}

// The merge gate's read of "this run was resumed" from the append-only side: a run-resumed event THE VIEWER wrote (any head: a resumed run stays
// resumed) counts; another author's comment, or a quoted marker, does not (parseEvent wants the marker at the very start). Never throws:
// { resumed, event, unreadable }. `unreadable` (a reason) means the answer is unknown and the caller must fail CLOSED, like an unreadable run record.
export function readResumedEvidence(gh, pr) {
  try {
    const me = gh.viewer();
    const found = gh.listComments(pr).map((c) => ({ c, ev: parseEvent(c.body) })).find(({ c, ev }) => ev?.kind === 'run-resumed' && c.user?.login === me);
    return { resumed: found !== undefined, event: found?.ev ?? null, unreadable: null };
  } catch (err) {
    return { resumed: false, event: null, unreadable: `the run-resumed events could not be read (${String(err?.message ?? err).slice(0, 200)})` };
  }
}
