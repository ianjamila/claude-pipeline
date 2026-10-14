// State and wording for `pipeline update --scheduled` (the hourly unattended update): when to push the owner, once.
// The state is one small JSON file next to the worktrees cron logs (~/.local/state/pipeline, or PIPELINE_PRUNE_LOG_DIR):
//   { pending: {key, episode}, notified: key, transient: {reason, runs} }
// A problem is keyed by (reason, main sha), so an hourly failure pushes once per main sha; a new main sha is a new key.
// A transient problem (network, a busy install lock) pushes only when it has failed TRANSIENT_RUNS runs in a row. Any
// run that ends well (nothing to do, or updated) clears the file, so the next failure pushes again. `pending` is written
// BEFORE the push so a retry after a crash reuses the same episode in notify's ledger key and cannot push twice;
// `notified` is written only once a push was delivered (or notify's ledger says it already was).
import fs from 'node:fs';
import path from 'node:path';
import { pruneLogDir } from './worktree-prune/run.mjs';

export const STATE_FILE = 'auto-update-state.json';
export const LOG_FILE = 'auto-update.log';
export const TRANSIENT_RUNS = 3;

export const stateDir = (env) => pruneLogDir(env);
export const stateFile = (env) => path.join(stateDir(env), STATE_FILE);
export const logFile = (env) => path.join(stateDir(env), LOG_FILE);

// {} for a missing, unreadable or malformed file: the worst case is one extra push.
export function readState(file, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try {
    const s = JSON.parse(readFile(file));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

// Never throws: a state that cannot be written costs a repeated push, not the update.
export function writeState(file, state, { mkdir = (d) => fs.mkdirSync(d, { recursive: true }), writeFile = (f, t) => fs.writeFileSync(f, t), rm = (f) => fs.rmSync(f, { force: true }) } = {}) {
  try {
    if (Object.keys(state).length === 0) rm(file);
    else {
      mkdir(path.dirname(file));
      writeFile(file, `${JSON.stringify(state)}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

// What this run does about the owner. `problem` is {reason, sha, transient} or null for a run that ended well.
// -> { push: {key, episode} | null, state } ; the caller persists `state`, pushes when `push` is set, then calls markNotified.
export function planPush(state, problem, { nowIso }) {
  if (!problem) return { push: null, state: {} };
  const key = `${problem.transient ? 'transient:' : ''}${problem.reason}:${problem.sha}`;
  const next = {};
  if (state.notified) next.notified = state.notified;
  if (problem.transient) {
    const runs = (state.transient?.reason === problem.reason ? Number(state.transient.runs) || 0 : 0) + 1;
    next.transient = { reason: problem.reason, runs };
    if (runs < TRANSIENT_RUNS) return { push: null, state: next };
  }
  else if (state.transient) delete next.transient; // a different, definite problem ends the streak
  if (next.notified === key) return { push: null, state: next };
  const episode = state.pending?.key === key ? state.pending.episode : nowIso;
  next.pending = { key, episode };
  return { push: { key, episode }, state: next };
}

export function markNotified(state, push) {
  const { pending, ...rest } = state;
  void pending;
  return { ...rest, notified: push.key };
}

const MANUAL = 'Run the manual update in your own terminal and read its error';

// The notify event for a problem; head = the main sha, so the ledger key is (reason, main sha, episode).
export function ownerEvent(problem, push) {
  const sha7 = String(problem.sha ?? '').slice(0, 7);
  let title;
  let action;
  if (problem.skipped === 'modified') {
    title = 'Pipeline auto-update paused';
    action = `The installed pipeline has local changes, so the hourly update left it alone. ${MANUAL.replace(' and read its error', '')} to replace it with main ${sha7}`;
  } else if (problem.skipped === 'downgrade') {
    title = 'Pipeline auto-update paused';
    action = `The installed pipeline is not behind main ${sha7} (it is ahead or has diverged), so the hourly update left it alone. Check it in your own terminal with \`pipeline update --check\``;
  } else if (problem.transient) {
    title = 'Pipeline auto-update failed';
    action = `${problem.reason} on ${TRANSIENT_RUNS} runs in a row. ${MANUAL}`;
  } else {
    title = 'Pipeline auto-update failed';
    action = `${problem.reason}${problem.message ? ` (${String(problem.message).replace(/\s+/g, ' ').slice(0, 120)})` : ''}. ${MANUAL}`;
  }
  return { event: 'pipeline-update', pr: null, title, action, head: problem.sha ?? 'unknown', outcome: problem.skipped ?? 'failed', cause: `${push.key}@${push.episode}` };
}
