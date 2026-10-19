// The run record: where a `ship` run stands, kept in the PR's summary comment so another session (or machine) can pick
// it up. It is display + routing hints, editable by anyone with comment rights and last-writer-wins; nothing that
// must not be lost lives only here (see run-events.mjs for the append-only evidence). Pure: no IO, no clock (callers
// pass `now` and `host`).
import { gunzipSync, gzipSync } from 'node:zlib';
import { MARKERS, clip, line } from './render.mjs';
import { addCostEntry, addRetries, addSessions, costLines, costShapeProblem, setGuardBlocks } from './run-cost.mjs';

export const RECORD_VERSION = 1;

export const STEPS = Object.freeze(['build', 'verify', 'pr', 'review', 'gate', 'awaiting-owner-merge', 'merge', 'prod-watch', 'ended']);

// null while the run is going; otherwise how it ended: every `P summary` outcome, then every prod-watch outcome.
export const OUTCOMES = Object.freeze([
  'merged', 'blocked', 'needs-human', 'awaiting-review', 'awaiting-owner-merge',
  'stopped', 'closed', 'merged-externally', 'prod-unknown',
  'superseded', 'recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped',
  'not-live', 'deploy-failed', 'deploy-not-observed', 'no-production', 'needs-owner',
]);

// Exhaustive: an outcome the run stopped at. `awaiting-owner-merge` is a place the run waits; `prod-unknown` (prod-watch
// exited with no outcome) leaves the merged run in its prod-watch step, so the inbox lists it as stranded and resume
// observes production again; every other outcome ends it.
export const OUTCOME_STEP = Object.freeze({
  merged: 'ended',
  blocked: 'ended',
  'needs-human': 'ended',
  'awaiting-review': 'ended',
  'awaiting-owner-merge': 'awaiting-owner-merge',
  stopped: 'ended',
  closed: 'ended',
  'merged-externally': 'ended',
  'prod-unknown': 'prod-watch',
  superseded: 'ended',
  recovered: 'ended',
  'rollback-failed': 'ended',
  'changed-during-recovery': 'ended',
  'rollback-skipped': 'ended',
  'not-live': 'ended',
  'deploy-failed': 'ended',
  'deploy-not-observed': 'ended',
  'no-production': 'ended',
  'needs-owner': 'ended',
});

// What a reader should do once the run stopped at this outcome (shown as "Next" in the status block).
export const OUTCOME_NEXT = Object.freeze({
  merged: 'nothing: merged',
  blocked: 'fix the verification failure, then resume',
  'needs-human': 'owner review: add `human-approved`, then merge',
  'awaiting-review': 'resume the cross-model review',
  'awaiting-owner-merge': 'owner says "merge" for this head',
  stopped: 'clear what stopped the run (see the action), then resume',
  closed: 'nothing: the PR was closed',
  'merged-externally': 'nothing: merged outside the pipeline',
  'prod-unknown': 'resume: observe production for this merge (never rolls back)',
  superseded: 'nothing: a newer deploy replaced this one',
  recovered: 'review the incident issue and the revert PR',
  'rollback-failed': 'owner: production may be down, check the incident issue',
  'changed-during-recovery': 'owner: production moved during the rollback, check it',
  'rollback-skipped': 'owner: no rollback was done, check production',
  'not-live': 'check why production did not go live',
  'deploy-failed': 'check the failed deployment',
  'deploy-not-observed': 'check production by hand',
  'no-production': 'nothing: no production environment',
  'needs-owner': 'owner: production fails the smoke and was left alone, check it and the rollback target',
});

// A merged run whose production result is still unknown: no outcome yet, or `prod-unknown`.
export const prodStillOpen = (record) => record?.outcome == null || record.outcome === 'prod-unknown';

export const STATUS_START = '<!-- claude-pipeline:status:start -->';
export const STATUS_END = '<!-- claude-pipeline:status:end -->';

const RECORD_MARKER = /<!-- claude-pipeline:record:([A-Za-z0-9+/=]+) -->/g;
// A record is a few KB; cap decompression so a hostile comment cannot make a reader allocate gigabytes.
const MAX_DECODED_BYTES = 1024 * 1024;

export const LIMITS = Object.freeze({ request: 2048, spec: 1024, title: 200, text: 500, history: 20, tasks: 50 });

const MAX_TASK_ID = 64;
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
  // Every reader (status block, checkpoint, resume plan) indexes these entries: one bad entry would throw in all of them.
  if (!r.tasks.every((t) => isPlainObject(t) && isStr(t.id) && t.id !== '' && t.id.length <= MAX_TASK_ID && (t.done === undefined || typeof t.done === 'boolean'))) return 'bad task';
  if (!r.history.every(isPlainObject)) return 'bad history entry';
  if (r.inFlight != null && !isPlainObject(r.inFlight)) return 'bad inFlight';
  if (r.heartbeat != null && !isPlainObject(r.heartbeat)) return 'bad heartbeat';
  // `proofs` is optional too (only a merge of a repo with verify.deferrable_steps writes it).
  if (r.proofs !== undefined) {
    const why = proofsProblem(r.proofs);
    if (why) return `bad proofs: ${why}`;
  }
  // `cost` is optional: a record from before cost attribution has none.
  return costShapeProblem(r.cost);
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

// ---- verify proofs (T2): where each deferrable verify step was proved when the PR merged -----------------------------------
// [{ step, source: 'local' }] (the Mac ran it) or [{ step, source: 'ci', run: { id, attempt, jobId, workflow, job, url } }] (GitHub's run
// vouched for it). Written by `P merge` from its live gate evaluation; display + audit (the append-only ci-proof-used event is the copy
// that survives a rewritten record).
// MAX_PROOFS / MAX_PROOF_STEP are the one source of the limits: config validation (verify.deferrable_steps, verify.ci_proof) enforces
// them too, so a config the validator accepts can never produce proofs this record refuses (merge would then refuse forever).
export const MAX_PROOFS = 20;
export const MAX_PROOF_STEP = 64;
const PROOF_STEP = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_PROOF_STEP}}$`);
const RUN_COUNTERS = ['id', 'attempt', 'jobId'];

function proofProblem(p) {
  if (!isPlainObject(p) || !isStr(p.step) || !PROOF_STEP.test(p.step)) return 'bad step name';
  if (p.source === 'local') return p.run === undefined ? null : 'a local proof names no run';
  if (p.source !== 'ci') return 'unknown source';
  const r = p.run;
  if (!isPlainObject(r)) return 'a ci proof needs a run';
  if (!RUN_COUNTERS.every((k) => Number.isInteger(r[k]) && r[k] > 0)) return 'run id, attempt and jobId must be positive whole numbers';
  if (!['workflow', 'job', 'url'].every((k) => isStr(r[k]) && r[k] !== '')) return 'run workflow, job and url must be text';
  return null;
}

export function proofsProblem(proofs) {
  if (!Array.isArray(proofs)) return 'proofs is not a list';
  if (proofs.length > MAX_PROOFS) return `more than ${MAX_PROOFS} proofs`;
  for (const p of proofs) {
    const why = proofProblem(p);
    if (why) return why;
  }
  return null;
}

// A NEW, trimmed copy; throws (naming the problem) on anything malformed, so a bad proof can never be recorded half-way.
export function normaliseProofs(proofs) {
  const why = proofsProblem(proofs);
  if (why) throw new Error(`proofs: ${why}`);
  return proofs.map((p) => (p.source === 'local'
    ? { step: p.step, source: 'local' }
    : {
      step: p.step, source: 'ci',
      run: {
        id: p.run.id, attempt: p.run.attempt, jobId: p.run.jobId,
        workflow: clip(p.run.workflow, LIMITS.title), job: clip(p.run.job, LIMITS.title), url: clip(p.run.url, LIMITS.text),
      },
    }));
}

// "<step> proof: GitHub run <id> attempt <n>" or "<step> proof: Mac".
export const proofLine = (p) => `${line(p.step)} proof: ${p.source === 'ci' ? `GitHub run ${p.run.id} attempt ${p.run.attempt}` : 'Mac'}`;

function normaliseTask(t, previous) {
  if (!isPlainObject(t) || t.id === undefined || t.id === null || String(t.id) === '') throw new Error('a task needs an id');
  if (String(t.id).length > MAX_TASK_ID) throw new Error(`task id ${JSON.stringify(String(t.id).slice(0, 20))}… is longer than ${MAX_TASK_ID} characters`);
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
// agentLogLine, cliVersion, proofs ([{step, source: 'local'} | {step, source: 'ci', run: {id, attempt, jobId, workflow, job, url}}], replaces the list; set by `P merge`), cost ({entry: {phase, role, input, output, cacheRead, cacheWrite, usd}, retries: n to add, sessions: [ids], guardBlocks: n | null, guardBySession: {id: n}; see run-cost.mjs), resumed ({at, host, head}: a run taken over by `ship resume`; set once, never cleared). Every call stamps the heartbeat and appends a history entry (capped, oldest dropped).
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
  if (patch.proofs !== undefined) next.proofs = normaliseProofs(patch.proofs);
  if (patch.cliVersion !== undefined) next.cliVersion = patch.cliVersion;
  if (patch.cost != null) {
    if (!isPlainObject(patch.cost)) throw new Error('cost must be an object');
    let cost = next.cost;
    if (patch.cost.entry !== undefined) cost = addCostEntry(cost, patch.cost.entry);
    if (patch.cost.retries !== undefined) cost = addRetries(cost, patch.cost.retries);
    if (patch.cost.sessions !== undefined) cost = addSessions(cost, patch.cost.sessions);
    if (patch.cost.guardBlocks !== undefined) cost = setGuardBlocks(cost, patch.cost.guardBlocks, patch.cost.guardBySession);
    next.cost = cost;
  }
  // A resumed record stays resumed: `null` / absent never clears it (only a record made fresh can lack it).
  if (patch.resumed != null) {
    if (!isPlainObject(patch.resumed)) throw new Error('resumed must be {at, host, head}');
    next.resumed = { at: String(patch.resumed.at ?? ''), host: String(patch.resumed.host ?? ''), head: String(patch.resumed.head ?? '') };
  }

  const at = new Date(now).toISOString();
  next.heartbeat = { host: String(host ?? ''), at };
  next.history = [...next.history, { step: next.step, head: next.head, host: next.heartbeat.host, at }].slice(-LIMITS.history);
  return next;
}

// The record to write when `P summary` / `P comment --kind summary` ends a run. An existing record is kept (and updated)
// when it belongs to this PR; otherwise a fresh one is made from what the caller knows. An outcome that is not in
// OUTCOMES is still shown in the comment, but never enters the record: it only adds a warning.
export function recordForOutcome(existing, { repo, pr, branch, baseRef, head, outcome, detail, agentLogLine, host, now, sessions, guardBlocks, guardBySession }) {
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
  // Sessions named now join the ones already recorded; `guardBlocks` / `guardBySession` (counted by the caller from the guard log) replace the old counts.
  if (sessions?.length || guardBlocks !== undefined) patch.cost = { ...(sessions?.length ? { sessions } : {}), ...(guardBlocks !== undefined ? { guardBlocks, ...(guardBySession !== undefined ? { guardBySession } : {}) } : {}) };
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
  for (const p of Array.isArray(r.proofs) ? r.proofs : []) out.push(`- ${proofLine(p)}`);
  out.push(...costLines(r.cost));
  if (r.detail) out.push(`- **Detail:** ${line(r.detail, LIMITS.text)}`);
  out.push(
    `- **Host:** ${r.heartbeat?.host ? line(r.heartbeat.host) : '—'} · **Heartbeat:** ${r.heartbeat?.at ? line(r.heartbeat.at) : '—'}`,
    STATUS_END,
  );
  return out.join('\n');
}
