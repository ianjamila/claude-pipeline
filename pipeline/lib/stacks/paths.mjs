// Where stack-stop keeps its state, and which projects a run may touch.
// One root holds everything (config, modes, ledger, locks, logs, report). Its default is under the user's ~/.claude; a
// different root (smoke tests, experiments) is an ISOLATED run and must name the only projects it may assess or stop
// (PIPELINE_STACKS_ONLY), so a stray override can never point a real stop at a real stack.
import path from 'node:path';
import os from 'node:os';
import { expandHome, canonicalPath, samePath } from '../paths.mjs';
import { seamValue } from '../proc.mjs';

export class StacksIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StacksIsolationError';
  }
}

export function stacksRoot(env = process.env, home = os.homedir()) {
  const raw = env?.PIPELINE_STACKS_HOME;
  if (raw) return path.resolve(expandHome(raw, home));
  return path.join(home, '.claude', 'pipeline-state', 'stacks');
}

export function stackFiles(root) {
  const f = (name) => path.join(root, name);
  return {
    config: f('config.json'),
    mode: f('mode.json'),
    keep: f('keep'),
    pause: f('pause'),
    ledger: f('ledger.jsonl'),
    ledgerBad: f('ledger.bad.jsonl'),
    actions: f('actions.jsonl'),
    report: f('report.md'),
    weekly: f('weekly-section.md'),
    cache: f('inventory.json'),
    locks: f('locks'), // base directory; the lock users below each get their own subdirectory
    workers: f('workers'),
    log: f('stacks.log'),
  };
}

// Lock namespaces are disjoint directories so a project named `ledger`, `sweep` or `dev-3000` can never collide with the
// global locks: project/<id>, ledger/ledger, sweep/sweep, dev/<port>. Lock order everywhere: project locks (sorted by
// name) first, then the ledger lock.
export function lockDirs(root) {
  const base = stackFiles(root).locks;
  return { project: path.join(base, 'project'), ledger: path.join(base, 'ledger'), sweep: path.join(base, 'sweep'), dev: path.join(base, 'dev') };
}

// A project id as a lock name: lowercase, every character outside [a-z0-9_-] becomes `_` (ids are case-insensitive
// everywhere else, and a lock name must be one safe path segment).
export const projectLockName = (id) => String(id).toLowerCase().replace(/[^a-z0-9_-]/g, '_');

const sameRoot = (a, b) => samePath(canonicalPath(a), canonicalPath(b));

export function isolation(env, root, { home = os.homedir() } = {}) {
  const isDefault = sameRoot(root, stacksRoot({}, home));
  const list = String(env?.PIPELINE_STACKS_ONLY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!isDefault && list.length === 0) {
    throw new StacksIsolationError('a non-default PIPELINE_STACKS_HOME requires PIPELINE_STACKS_ONLY (comma-separated project ids)');
  }
  // A list given for the default root still restricts the run (never widens it).
  return { isDefault, only: list.length ? new Set(list) : null };
}

export const projectAllowed = (project, iso) => iso.only === null || iso.only.has(String(project).toLowerCase());

// A stack-stop test override (fake docker / ps / lsof / supabase, a short deadline). Honoured only in the repo checkout
// (seamValue ignores it in an installed copy) AND only for an isolated run: PIPELINE_STACKS_HOME set to a root other than
// the default one, plus PIPELINE_STACKS_ONLY. So no environment variable can bend a real hook against the real state.
// `root` is the pipeline root seamValue judges "installed" by; `home` decides what the default state root is.
export function stacksSeam(name, env, { root, home = os.homedir(), warn } = {}) {
  const value = seamValue(name, env, { root, ...(warn ? { warn } : {}) });
  if (value === undefined) return undefined;
  const stateHome = env?.PIPELINE_STACKS_HOME;
  if (!stateHome || !String(env?.PIPELINE_STACKS_ONLY ?? '').trim()) return undefined;
  if (sameRoot(stacksRoot(env, home), stacksRoot({}, home))) return undefined;
  return value;
}
