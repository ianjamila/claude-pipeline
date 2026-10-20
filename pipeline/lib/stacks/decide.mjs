// Pure verdicts for stack-stop: may this private Supabase stack be stopped? No fs, no subprocess, no environment, no clock:
// every fact (including time, as `uptimeMs`) comes in as an input, so every rule below is testable one flipped input at a time.
// This header is the rulebook; the spec is docs/specs/2026-10-19-stack-stop-design.md.
//
// HARD RULES
// - Shared stacks are never stopped: the machine-config `shared` ids (this Mac: e2e-ci, DRMed, eaglewatch-pipeline), any project
//   id ending `-pipeline`, any workdir under `/.verify/supabase-workdir`; compared case-insensitively. `stack.shared` carries the
//   config answer; the two built-in rules are re-checked here as a backstop.
// - Fail closed. Every probe is `{ok:true, value} | {ok:false, reason}`; an unknown on any required input means NOT stop. A
//   damaged ledger arrives as unknown leases, so nothing is stopped.
// - Target binding, checked by checkBinding immediately before each stop under the project lock. ALL must agree, else keep:
//   realpath(workdir) == the running db container's `com.supabase.cli.workdir` label (realpath'd) == the workdir assessed;
//   project_id read NOW from `<workdir>/supabase/config.toml` == the container's `com.supabase.cli.project` label == the
//   project assessed; that project is not shared; container Id and `State.StartedAt` == the ones assessed (a restarted
//   container is a new generation, reassessed next run). A stack whose workdir no longer exists is report-only (binding cannot
//   be proved); there is no `--project-id` fallback. Strings compare exactly (no case folding): a mismatch only ever keeps.
// - The only stop command is `supabase stop --workdir <realpath>` (act.mjs). Nothing in this file runs anything.
// - Pause (`pause` file) stops everything on every path. A keep-listed project is never stopped.
//
// WHO COUNTS AS USING A STACK (any one is enough, all evaluated together)
//   C1 ledger lease        a live Claude process registered a use; it ends only when that {pid, birth} is dead.
//   C2 live connection     an ESTABLISHED TCP connection to any published host port of the stack, counted from the server side,
//                          so a client whose process we cannot see is still a connection (`{pid:null, birth:null,
//                          command:'hidden client'}`); it is never ignored.
//   C3 process reference   any process whose command line OR environment names the stack folder, workdir, a container name, the
//                          project id (whole word) or a published port.
//   cwd                    a live process whose cwd/open files are inside the stack folder or any consumer worktree.
//   C4 consumer worktrees  worktrees tied to the stack by the ledger, a transcript backfill, or a `.env*` pointing at its ports.
//   C6 recent transcripts  (sweeper only) a transcript modified in the last 24 h names the stack folder/project.
//
// OTHER USERS' PROCESSES (stated, not silent). Another user's real use of a stack is caught by C2 (server side: the Docker/OrbStack
// helper runs as this user and shows every connection whoever the client is) and by C3's command line (ps shows every user's).
// Their environment and cwd/open files can only be read for THIS user's processes (without root they are invisible). The probes
// report the count as `hidden: N`; the verdicts below copy it to `notes` so reports say so.
//
// SESSION-END verdict (sessionEndVerdict): stop only if the db container is running; not shared; workdir exists and the binding
// holds; not keep-listed; not paused; no live lease from another owner (C1); no connection (C2); no process reference (C3); no
// live process with cwd in the stack folder or any consumer worktree. Anything else: `kept` + reasons (unknown included).
//
// SWEEP verdict (sweepVerdict), the owner's seven conditions made precise, plus workdir/binding and C6:
//   1. not shared;
//   2. no live ledger lease (C1);
//   3. the consumer-worktree set (C4) is NON-EMPTY and EVERY member is eligible: gone (GONE), or its PR is MERGED/CLOSED with
//      HEAD == the PR head. Folder names never identify owners; an empty set means the owner is unknown => listed. A consumer
//      that exists with NO PR, or whose PR head differs from its HEAD, => listed (never stop). Any consumer with an OPEN PR
//      => kept (a mixed set, one gone/merged and one OPEN, is therefore kept);
//   4. no live process with cwd in any consumer worktree or the stack folder; no C2 connection; no C3 reference;
//   5. the db container has been up for MORE than 24 h (`uptimeMs > DAY_MS`; exactly 24 h is not more);
//   6. no memory note names the project id or the stack folder name;
//   7. not keep-listed;
//   plus: the workdir exists and the binding holds, not paused, and no C6 recent transcript.
//
// VERDICT MEANING (sweep): `listed` = cannot decide (owner unknown, any unknown probe, missing workdir, no consumers known,
// no PR, head mismatch, binding not proved); `kept` = positive evidence of use or a standing rule (live lease, connection incl.
// hidden client, process reference, cwd process, OPEN PR, memory mention, recent transcript, keep-listed, uptime <= 24 h,
// paused, shared). `kept` wins over `listed` when both apply. Every non-stop verdict has reasons that name the input.
// sessionEndVerdict has only `stop` | `kept` (an unknown there is kept).
export const DAY_MS = 86_400_000;

const BUILT_IN_SHARED_SUFFIX = '-pipeline';
const BUILT_IN_SHARED_WORKDIR = '/.verify/supabase-workdir';

const lower = (v) => String(v ?? '').toLowerCase();
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const posix = (p) => String(p ?? '').replace(/\\/g, '/');

// The built-in shared rules, independent of any machine config (defence in depth; stack.shared is the config answer).
function builtInShared({ project, workdir } = {}) {
  const id = lower(project);
  if (id !== '' && id.endsWith(BUILT_IN_SHARED_SUFFIX)) return true;
  if (nonEmpty(workdir) && lower(posix(workdir)).includes(BUILT_IN_SHARED_WORKDIR)) return true;
  return false;
}

// checkBinding(assessed, current) -> { ok, reasons }. `assessed` is what the verdict was made on: the Stack from inventory
// ({ workdir (real), project, shared, generation: { id, startedAt } }). `current` is read NOW under the project lock:
// { workdirExists, workdirReal, labelWorkdirReal, configProject, labelProject, generation: { id, startedAt }, shared }.
// A missing or empty field never agrees with anything (so null === null cannot pass). `ok` is true only with no reasons.
export function checkBinding(assessed, current) {
  const reasons = [];
  const a = assessed ?? {};
  const c = current ?? {};
  if (c.workdirExists !== true) reasons.push('binding: workdir does not exist (report-only, binding cannot be proved)');
  if (!nonEmpty(a.workdir)) reasons.push('binding: assessed workdir unknown');
  const same = (x, y) => nonEmpty(x) && nonEmpty(y) && x === y;
  if (!same(c.workdirReal, a.workdir)) reasons.push(`binding: workdir realpath ${c.workdirReal ?? 'unknown'} != assessed ${a.workdir ?? 'unknown'}`);
  if (!same(c.labelWorkdirReal, a.workdir)) reasons.push(`binding: container workdir label ${c.labelWorkdirReal ?? 'unknown'} != assessed ${a.workdir ?? 'unknown'}`);
  if (!same(c.labelWorkdirReal, c.workdirReal)) reasons.push(`binding: container workdir label ${c.labelWorkdirReal ?? 'unknown'} != workdir realpath ${c.workdirReal ?? 'unknown'}`);
  if (!nonEmpty(a.project)) reasons.push('binding: assessed project unknown');
  if (!same(c.configProject, a.project)) reasons.push(`binding: config.toml project_id ${c.configProject ?? 'unknown'} != assessed ${a.project ?? 'unknown'}`);
  if (!same(c.labelProject, a.project)) reasons.push(`binding: container project label ${c.labelProject ?? 'unknown'} != assessed ${a.project ?? 'unknown'}`);
  if (!same(c.configProject, c.labelProject)) reasons.push(`binding: config.toml project_id ${c.configProject ?? 'unknown'} != container project label ${c.labelProject ?? 'unknown'}`);
  const ag = a.generation;
  const cg = c.generation;
  if (!same(cg?.id, ag?.id)) reasons.push(`binding: container id ${cg?.id ?? 'unknown'} != assessed ${ag?.id ?? 'unknown'} (a different container)`);
  if (!same(cg?.startedAt, ag?.startedAt)) reasons.push(`binding: container StartedAt ${cg?.startedAt ?? 'unknown'} != assessed ${ag?.startedAt ?? 'unknown'} (restarted: a new generation)`);
  if (c.shared !== false) reasons.push('binding: project is shared (or sharing unknown)');
  if (a.shared === true) reasons.push('binding: assessed stack is shared');
  for (const [name, p, w] of [['assessed', a.project, a.workdir], ['config.toml', c.configProject, c.workdirReal], ['container label', c.labelProject, c.labelWorkdirReal]]) {
    if (builtInShared({ project: p, workdir: w })) reasons.push(`binding: ${name} names a shared stack`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- helpers shared by both verdicts ----

// Collects reasons by kind. unknown results go to `listed` for the sweep and to `kept` for session-end (see finish()).
function collector() {
  const kept = [];
  const listed = [];
  const notes = [];
  const passed = [];
  return { kept, listed, notes, passed };
}

// The value of a required probe, or undefined (with a 'listed' reason) when it is not ok.
function need(c, name, r) {
  if (r && r.ok === true) {
    if (Number.isFinite(r.hidden) && r.hidden > 0) c.notes.push(`${name}: ${r.hidden} other-user process(es) hidden (environment and cwd are not readable for them)`);
    for (const n of Array.isArray(r.notes) ? r.notes : []) c.notes.push(`${name}: ${n}`);
    return r.value;
  }
  c.listed.push(`${name} unknown: ${r?.reason ?? 'no result'}`);
  return undefined;
}

const sizeOf = (v) => (Array.isArray(v) ? v.length : v instanceof Map || v instanceof Set ? v.size : null);

const describeOwner = (o) => `pid ${o?.pid ?? '?'}`;

function leaseReasons(c, name, value) {
  const n = sizeOf(value);
  if (n === null) { c.listed.push(`${name} unknown: unexpected result shape`); return; }
  if (n === 0) { c.passed.push(`${name}: none`); return; }
  const list = value instanceof Map ? [...value.values()] : Array.from(value);
  c.kept.push(`${name}: ${n} live lease(s) (${list.map((l) => describeOwner(l?.owner ?? l)).join(', ')})`);
}

function connectionReasons(c, value) {
  if (!Array.isArray(value)) { c.listed.push('connections unknown: unexpected result shape'); return; }
  if (value.length === 0) { c.passed.push('connections: none'); return; }
  c.kept.push(`connections: ${value.length} live connection(s) (${value.map((x) => `${x?.pid ?? 'no pid'} ${x?.command ?? '?'} -> port ${x?.port ?? '?'}`).join('; ')})`);
}

function refReasons(c, value) {
  if (!Array.isArray(value)) { c.listed.push('processRefs unknown: unexpected result shape'); return; }
  if (value.length === 0) { c.passed.push('processRefs: none'); return; }
  c.kept.push(`processRefs: ${value.length} process(es) name the stack (${value.map((x) => `pid ${x?.pid ?? '?'} ${x?.field ?? '?'}: ${String(x?.command ?? '').slice(0, 80)}`).join('; ')})`);
}

function cwdReasons(c, value) {
  if (!Array.isArray(value)) { c.listed.push('cwdProcs unknown: unexpected result shape'); return; }
  if (value.length === 0) { c.passed.push('cwdProcs: none'); return; }
  c.kept.push(`cwdProcs: ${value.length} live process(es) with cwd in the stack folder or a consumer worktree (${value.map((x) => `pid ${x?.pid ?? '?'} in ${x?.dir ?? '?'}`).join('; ')})`);
}

function keepReasons(c, value, project) {
  const items = value instanceof Set || Array.isArray(value) ? [...value] : null;
  if (items === null) { c.listed.push('keep unknown: unexpected result shape'); return; }
  if (items.some((id) => lower(id) === lower(project))) c.kept.push(`keep: ${project} is on the keep list`);
  else c.passed.push('keep: not keep-listed');
}

// Rules that apply the same way to both verdicts: paused, shared, running db container, workdir, binding.
function commonRules(c, e) {
  const stack = e.stack ?? {};
  if (e.paused === true) c.kept.push('paused: the pause file is present');
  else if (e.paused !== false) c.listed.push('paused unknown: pause state not provided');
  else c.passed.push('not paused');
  if (stack.shared === false && !builtInShared(stack)) c.passed.push('not shared');
  else c.kept.push(`shared: ${stack.project ?? 'stack'} is a shared stack (never stopped)`);
  if (!stack.generation || !nonEmpty(stack.generation.id)) c.listed.push('generation unknown: no database container assessed');
  else if (Array.isArray(stack.containers) && !stack.containers.some((x) => x?.id === stack.generation.id && x?.running === true)) c.kept.push('not running: the database container is not running (nothing to stop)');
  if (stack.workdirExists !== true || !nonEmpty(stack.workdir)) c.listed.push('workdir missing or unknown: report-only (binding cannot be proved)');
  const b = e.binding;
  if (!b || b.ok !== true) c.listed.push(...(Array.isArray(b?.reasons) && b.reasons.length ? b.reasons : [`binding not proved: ${b?.reason ?? 'no binding result'}`]));
  else c.passed.push('binding holds');
}

// ---- verdicts ----

// e = { stack, paused, keep, otherLiveLeases, connections, processRefs, cwdProcs, binding }  -> { verdict: 'stop'|'kept', reasons, notes }
export function sessionEndVerdict(e = {}) {
  const c = collector();
  commonRules(c, e);
  const k = need(c, 'keep', e.keep);
  if (k !== undefined) keepReasons(c, k, e.stack?.project);
  const leases = need(c, 'otherLiveLeases', e.otherLiveLeases);
  if (leases !== undefined) leaseReasons(c, 'otherLiveLeases', leases);
  const conn = need(c, 'connections', e.connections);
  if (conn !== undefined) connectionReasons(c, conn);
  const refs = need(c, 'processRefs', e.processRefs);
  if (refs !== undefined) refReasons(c, refs);
  const cwd = need(c, 'cwdProcs', e.cwdProcs);
  if (cwd !== undefined) cwdReasons(c, cwd);
  // session-end has no `listed`: whatever cannot be decided is kept
  const reasons = [...c.kept, ...c.listed];
  if (reasons.length > 0) return { verdict: 'kept', reasons, notes: c.notes };
  return { verdict: 'stop', reasons: c.passed, notes: c.notes };
}

function consumerReasons(c, consumers, states) {
  if (consumers === undefined || states === undefined) return;
  if (!Array.isArray(consumers)) { c.listed.push('consumers unknown: unexpected result shape'); return; }
  if (!(states instanceof Map)) { c.listed.push('prStates unknown: unexpected result shape'); return; }
  if (consumers.length === 0) { c.listed.push('consumers: no consumer worktree is known, so the owner is unknown'); return; }
  const open = [];
  const undecided = [];
  for (const w of consumers) {
    const s = states.get(w?.path);
    if (!s || typeof s !== 'object') { undecided.push(`${w?.path ?? '?'} has no PR state`); continue; }
    if (s.state === 'OPEN') open.push(w.path);
    else if (s.state === 'GONE') continue;
    else if ((s.state === 'MERGED' || s.state === 'CLOSED') && s.headMatches === true) continue;
    else if (s.state === 'NONE') undecided.push(`${w.path} has no PR`);
    else if (s.state === 'MERGED' || s.state === 'CLOSED') undecided.push(`${w.path} PR is ${s.state} but its head differs from the worktree HEAD`);
    else undecided.push(`${w.path} has an unrecognised PR state ${String(s.state)}`);
  }
  if (open.length) c.kept.push(`prStates: consumer worktree(s) with an OPEN PR: ${open.join(', ')}`);
  if (undecided.length) c.listed.push(`prStates: cannot decide: ${undecided.join('; ')}`);
  if (!open.length && !undecided.length) c.passed.push(`prStates: all ${consumers.length} consumer worktree(s) gone or merged/closed at HEAD`);
}

function listReasons(c, name, value, label) {
  if (!Array.isArray(value)) { c.listed.push(`${name} unknown: unexpected result shape`); return; }
  if (value.length === 0) { c.passed.push(`${name}: none`); return; }
  c.kept.push(`${name}: ${label} ${value.slice(0, 5).join(', ')}${value.length > 5 ? ` (+${value.length - 5} more)` : ''}`);
}

// e = { stack, paused, keep, liveLeases, consumers, prStates, cwdProcs, connections, processRefs, uptimeMs, memory, transcripts, binding }
//   -> { verdict: 'stop'|'kept'|'listed', reasons, notes }
export function sweepVerdict(e = {}) {
  const c = collector();
  commonRules(c, e);
  const k = need(c, 'keep', e.keep);
  if (k !== undefined) keepReasons(c, k, e.stack?.project);
  const leases = need(c, 'liveLeases', e.liveLeases);
  if (leases !== undefined) leaseReasons(c, 'liveLeases', leases);
  const consumers = need(c, 'consumers', e.consumers);
  const states = need(c, 'prStates', e.prStates);
  consumerReasons(c, consumers, states);
  const cwd = need(c, 'cwdProcs', e.cwdProcs);
  if (cwd !== undefined) cwdReasons(c, cwd);
  const conn = need(c, 'connections', e.connections);
  if (conn !== undefined) connectionReasons(c, conn);
  const refs = need(c, 'processRefs', e.processRefs);
  if (refs !== undefined) refReasons(c, refs);
  if (!Number.isFinite(e.uptimeMs)) c.listed.push('uptimeMs unknown: container start time not provided');
  else if (!(e.uptimeMs > DAY_MS)) c.kept.push(`uptimeMs: up ${Math.round(e.uptimeMs / 60000)} min, must be more than 24 h`);
  else c.passed.push('uptime: more than 24 h');
  const mem = need(c, 'memory', e.memory);
  if (mem !== undefined) listReasons(c, 'memory', mem, 'memory note(s) name the stack:');
  const tr = need(c, 'transcripts', e.transcripts);
  if (tr !== undefined) listReasons(c, 'transcripts', tr, 'transcript(s) modified in the last 24 h name the stack:');
  if (c.kept.length) return { verdict: 'kept', reasons: [...c.kept, ...c.listed], notes: c.notes };
  if (c.listed.length) return { verdict: 'listed', reasons: c.listed, notes: c.notes };
  return { verdict: 'stop', reasons: c.passed, notes: c.notes };
}

