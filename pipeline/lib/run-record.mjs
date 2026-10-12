// The run record: where a `ship` run stands, kept in the PR's summary comment so another session (or machine) can pick
// it up. It is display + routing hints, editable by anyone with comment rights and last-writer-wins; nothing that
// must not be lost lives only here (see run-events.mjs for the append-only evidence). Pure: no IO, no clock (callers
// pass `now` and `host`).
import { gunzipSync, gzipSync } from 'node:zlib';
import { MARKERS, clip, line } from './render.mjs';

export const RECORD_VERSION = 1;

export const STEPS = Object.freeze(['build', 'verify', 'pr', 'review', 'gate', 'awaiting-owner-merge', 'merge', 'prod-watch', 'ended']);

// null while the run is going; otherwise how it ended: every `P summary` outcome, then every prod-watch outcome.
export const OUTCOMES = Object.freeze([
  'merged', 'blocked', 'needs-human', 'awaiting-review', 'awaiting-owner-merge',
  'superseded', 'recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped',
  'not-live', 'deploy-failed', 'deploy-not-observed', 'no-production',
]);

// Exhaustive: an outcome the run stopped at. `awaiting-owner-merge` is a place the run waits, every other outcome ends it.
export const OUTCOME_STEP = Object.freeze({
  merged: 'ended',
  blocked: 'ended',
  'needs-human': 'ended',
  'awaiting-review': 'ended',
  'awaiting-owner-merge': 'awaiting-owner-merge',
  superseded: 'ended',
  recovered: 'ended',
  'rollback-failed': 'ended',
  'changed-during-recovery': 'ended',
  'rollback-skipped': 'ended',
  'not-live': 'ended',
  'deploy-failed': 'ended',
  'deploy-not-observed': 'ended',
  'no-production': 'ended',
});

// What a reader should do once the run stopped at this outcome (shown as "Next" in the status block).
export const OUTCOME_NEXT = Object.freeze({
  merged: 'nothing: merged',
  blocked: 'fix the verification failure, then resume',
  'needs-human': 'owner review: add `human-approved`, then merge',
  'awaiting-review': 'resume the cross-model review',
  'awaiting-owner-merge': 'owner says "merge" for this head',
  superseded: 'nothing: a newer deploy replaced this one',
  recovered: 'review the incident issue and the revert PR',
  'rollback-failed': 'owner: production may be down, check the incident issue',
  'changed-during-recovery': 'owner: production moved during the rollback, check it',
  'rollback-skipped': 'owner: no rollback was done, check production',
  'not-live': 'check why production did not go live',
  'deploy-failed': 'check the failed deployment',
  'deploy-not-observed': 'check production by hand',
  'no-production': 'nothing: no production environment',
});

export const STATUS_START = '<!-- claude-pipeline:status:start -->';
export const STATUS_END = '<!-- claude-pipeline:status:end -->';

const RECORD_MARKER = /<!-- claude-pipeline:record:([A-Za-z0-9+/=]+) -->/g;
// A record is a few KB; cap decompression so a hostile comment cannot make a reader allocate gigabytes.
const MAX_DECODED_BYTES = 1024 * 1024;

export const LIMITS = Object.freeze({ request: 2048, spec: 1024, title: 200, text: 500, history: 20, tasks: 50 });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

// base64 never contains "--", so the payload cannot terminate the HTML comment early.
export const packJson = (value) => gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');

// Throws on anything that is not gzip + base64 of JSON within the cap; callers turn that into "invalid".
export function unpackJson(b64) {
  return JSON.parse(gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_DECODED_BYTES }).toString('utf8'));
}

export function emptyRecord({ repo, pr, branch, baseRef }) {
  return {
    v: RECORD_VERSION,
    repo: repo ?? '',
    pr,
    branch: branch ?? '',
    baseRef: baseRef ?? '',
    step: 'build',
    outcome: null,
    next: '',
    detail: '',
    head: null,
    request: '',
    tasks: [],
    verify: null,
    round: 0,
    mergeSha: null,
    inFlight: null,
    heartbeat: null,
    agentLogLine: null,
    cliVersion: null,
    history: [],
  };
}

export const encodeRecord = (record) => `<!-- claude-pipeline:record:${packJson(record)} -->`;

function shapeProblem(r) {
  if (!isPlainObject(r)) return 'not an object';
  if (!Number.isInteger(r.v) || r.v < 1) return 'bad version';
  if (!Number.isInteger(r.pr) || r.pr <= 0) return 'bad pr';
  if (!STEPS.includes(r.step)) return 'unknown step';
  if (r.outcome !== null && !OUTCOMES.includes(r.outcome)) return 'unknown outcome';
  if (!Array.isArray(r.tasks) || !Array.isArray(r.history)) return 'tasks/history are not lists';
  if (r.inFlight != null && !isPlainObject(r.inFlight)) return 'bad inFlight';
  if (r.heartbeat != null && !isPlainObject(r.heartbeat)) return 'bad heartbeat';
  return null;
}

// Never throws. `body` is a comment body the caller already knows is viewer-authored. Only a body that STARTS with the
// summary marker is a summary: a quoted marker (or a forged record) elsewhere is not. The LAST record marker wins.
export function decodeRecord(body) {
  if (typeof body !== 'string' || !body.startsWith(MARKERS.summary)) return { status: 'absent' };
  const matches = [...body.matchAll(RECORD_MARKER)];
  if (matches.length === 0) return { status: 'legacy' };
  let record;
  try {
    record = unpackJson(matches.at(-1)[1]);
  } catch {
    return { status: 'invalid' };
  }
  if (isPlainObject(record) && Number.isInteger(record.v) && record.v > RECORD_VERSION) return { status: 'unsupported' };
  return shapeProblem(record) ? { status: 'invalid' } : { status: 'ok', record };
}

// Why this record does not belong to the live PR (empty = it does). `head` is not compared: it only informs.
export function bindRecord(record, { repo, pr, branch }) {
  const reasons = [];
  const check = (what, recorded, live) => {
    if (live !== undefined && recorded !== live) reasons.push(`${what}: the record says ${JSON.stringify(recorded)}, the PR is ${JSON.stringify(live)}`);
  };
  check('repo', record.repo, repo);
  check('pr', record.pr, pr);
  check('branch', record.branch, branch);
  return reasons;
}

const text = (v, max) => clip(String(v ?? '').trim(), max);

function normaliseTask(t, previous) {
  if (!isPlainObject(t) || t.id === undefined || t.id === null || String(t.id) === '') throw new Error('a task needs an id');
  return {
    id: String(t.id),
    title: text(t.title ?? previous?.title, LIMITS.title),
    spec: text(t.spec ?? previous?.spec, LIMITS.spec),
    done: t.done === undefined ? previous?.done === true : t.done === true,
  };
}

function normaliseInFlight(v) {
  if (v === null) return null;
  if (!isPlainObject(v) || !isStr(v.kind) || v.kind === '') throw new Error('inFlight needs a kind');
  return {
    kind: v.kind,
    host: String(v.host ?? ''),
    startedAt: String(v.startedAt ?? ''),
    maxMinutes: Number.isFinite(v.maxMinutes) ? v.maxMinutes : null,
  };
}

// Returns a NEW record. `patch` keys (all optional): step, outcome, next, detail, head, request, tasks (the full list,
// done kept for ids it omits `done` for), done (ids to mark done), verify, round, mergeSha, inFlight (object | null),
// agentLogLine, cliVersion. Every call stamps the heartbeat and appends a history entry (capped, oldest dropped).
export function applyCheckpoint(record, patch, { host, now }) {
  const next = structuredClone(record);
  if (patch.step !== undefined) {
    if (!STEPS.includes(patch.step)) throw new Error(`unknown step ${JSON.stringify(patch.step)}`);
    next.step = patch.step;
  }
  if (patch.outcome !== undefined) {
    if (patch.outcome !== null && !OUTCOMES.includes(patch.outcome)) throw new Error(`unknown outcome ${JSON.stringify(patch.outcome)}`);
    next.outcome = patch.outcome;
  }
  if (patch.next !== undefined) next.next = text(patch.next, LIMITS.text);
  if (patch.detail !== undefined) next.detail = text(patch.detail, LIMITS.text);
  if (patch.head !== undefined) next.head = patch.head === null ? null : String(patch.head);
  if (patch.request !== undefined) next.request = text(patch.request, LIMITS.request);
  if (patch.tasks !== undefined) {
    if (!Array.isArray(patch.tasks)) throw new Error('tasks must be a list');
    if (patch.tasks.length > LIMITS.tasks) throw new Error(`at most ${LIMITS.tasks} tasks`);
    const before = new Map(next.tasks.map((t) => [t.id, t]));
    next.tasks = patch.tasks.map((t) => normaliseTask(t, before.get(String(t?.id))));
  }
  if (patch.done !== undefined) {
    const ids = new Set(patch.done.map(String));
    for (const id of ids) if (!next.tasks.some((t) => t.id === id)) throw new Error(`unknown task id ${JSON.stringify(id)}`);
    next.tasks = next.tasks.map((t) => (ids.has(t.id) ? { ...t, done: true } : t));
  }
  if (patch.verify !== undefined) next.verify = patch.verify;
  if (patch.round !== undefined) next.round = patch.round;
  if (patch.mergeSha !== undefined) next.mergeSha = patch.mergeSha;
  if (patch.inFlight !== undefined) next.inFlight = normaliseInFlight(patch.inFlight);
  if (patch.agentLogLine !== undefined) next.agentLogLine = patch.agentLogLine;
  if (patch.cliVersion !== undefined) next.cliVersion = patch.cliVersion;

  const at = new Date(now).toISOString();
  next.heartbeat = { host: String(host ?? ''), at };
  next.history = [...next.history, { step: next.step, head: next.head, host: next.heartbeat.host, at }].slice(-LIMITS.history);
  return next;
}

// The record to write when `P summary` / `P comment --kind summary` ends a run. An existing record is kept (and updated)
// when it belongs to this PR; otherwise a fresh one is made from what the caller knows. An outcome that is not in
// OUTCOMES is still shown in the comment, but never enters the record: it only adds a warning.
export function recordForOutcome(existing, { repo, pr, branch, baseRef, head, outcome, detail, agentLogLine, host, now }) {
  const warnings = [];
  let base = existing;
  if (base) {
    const mismatch = bindRecord(base, { repo, pr, branch });
    if (mismatch.length) {
      warnings.push(`the existing run record does not belong to this PR (${mismatch.join('; ')}); started a new one`);
      base = null;
    }
  }
  base ??= emptyRecord({ repo, pr, branch, baseRef });
  const patch = {};
  if (head) patch.head = head;
  if (agentLogLine !== undefined) patch.agentLogLine = agentLogLine;
  if (OUTCOMES.includes(outcome)) {
    patch.outcome = outcome;
    patch.step = OUTCOME_STEP[outcome];
    patch.next = OUTCOME_NEXT[outcome];
    patch.detail = detail ?? '';
    patch.inFlight = null;
  } else {
    warnings.push(`unknown outcome ${JSON.stringify(String(outcome).slice(0, 60))}: shown in the comment, not recorded`);
  }
  return { record: applyCheckpoint(base, patch, { host, now }), warnings };
}

// ---- the status block (what a person sees at the top of the summary comment) ------------------

export function renderStatusBlock(record) {
  const r = record;
  const head = r.head ? `\`${line(String(r.head).slice(0, 7)).replace(/`/g, "'")}\`` : '—';
  const done = (r.tasks ?? []).filter((t) => t.done === true).length;
  const total = (r.tasks ?? []).length;
  const f = r.inFlight;
  const out = [
    STATUS_START,
    '### Pipeline run status',
    '',
    `- **Step:** ${line(r.step)} · **Outcome:** ${r.outcome ? line(r.outcome) : 'running'}`,
    `- **Next:** ${r.next ? line(r.next, LIMITS.text) : '—'}`,
    `- **Head:** ${head} · **Round:** ${line(r.round ?? 0)}${total ? ` · **Tasks:** ${done}/${total} done` : ''}`,
  ];
  if (f) out.push(`- **In flight:** ${line(f.kind)} on ${line(f.host)} since ${line(f.startedAt)}${f.maxMinutes ? ` (max ${line(f.maxMinutes)} min)` : ''}`);
  if (r.detail) out.push(`- **Detail:** ${line(r.detail, LIMITS.text)}`);
  out.push(
    `- **Host:** ${r.heartbeat?.host ? line(r.heartbeat.host) : '—'} · **Heartbeat:** ${r.heartbeat?.at ? line(r.heartbeat.at) : '—'}`,
    STATUS_END,
  );
  return out.join('\n');
}
