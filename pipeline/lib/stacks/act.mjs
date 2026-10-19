// The only place stack-stop changes anything: stopStack, one private stack, under its project lock, after a full re-check.
//
// HARD RULES
// - The ONLY mutating call is `supabase stop --workdir <realpath>`, argv built by stopArgs (the single place). Never a bare
//   stop, `--project-id`, `--all` or `--no-backup`; never `docker rm`, `docker stop` or `docker volume rm`. This file's docker
//   calls are read-only (`inspect`, `volume inspect`). A workdir that does not exist (or is not its own realpath) => no call.
// - Everything below runs while holding the project lock (`project/<id>`, see paths.mjs). Under it, in this order:
//   1. the generation container is looked at: gone or not running => `already-stopped` (a second session that left at the
//      same moment lands here and makes no call);
//   2. `reassess()` re-runs the inventory and the caller's verdict; the verdict must still be `stop` and checkBinding must
//      hold against the state read NOW;
//   3. the database volume (the one mounted at /var/lib/postgresql/data) must be known, so the post-check can name it;
//   4. fresh gates, read right before the call: pause file absent, machine config `ok`, and the mode for this source is
//      `apply` in mode.json NOW. A gate that fails => `kept` (paused / not configured / mode report), no call. Mode `report`
//      (the caller's, or the file's) with every other gate open => `would-stop`.
//   5. the single supabase call, never retried;
//   6. post-check: the generation container is absent or not running, AND the database volume still exists. A missing
//      volume is still `stopped` but carries `alert: 'db-volume-missing'`.
// - Anything unknown on the way keeps the stack (fail closed). Every decision goes to `log` (Task 9 wires appendDecision).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as realRun, findOnPosixPath } from '../proc.mjs';
import { acquire as realAcquire, release as realRelease, LockTimeoutError } from '../locks.mjs';
import { loadMachineConfig, loadModes, isPaused } from './config.mjs';
import { stacksSeam, stackFiles, lockDirs, projectLockName } from './paths.mjs';
import { checkBinding } from './decide.mjs';

export const FORBIDDEN = ['--all', '--no-backup', '--project-id'];

const STOP_TIMEOUT_MS = 120_000;
const INSPECT_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 60_000;
const DB_DATA_DIR = '/var/lib/postgresql/data';

// The one stop argv. A workdir that is not an absolute path (a flag, a relative name, nothing) is a bug in the caller.
export function stopArgs(workdirReal) {
  if (typeof workdirReal !== 'string' || workdirReal.trim() === '' || !(path.posix.isAbsolute(workdirReal) || path.win32.isAbsolute(workdirReal))) {
    throw new Error(`stopArgs needs an absolute workdir path, got ${JSON.stringify(workdirReal)}`);
  }
  return ['stop', '--workdir', workdirReal];
}

// The supabase binary: the PIPELINE_SUPABASE test seam (isolated runs in the checkout only, see stacksSeam), else `supabase`
// found on PATH or in the usual install dirs (a launchd PATH lacks /opt/homebrew/bin), else the bare name so a missing CLI
// fails as a spawn error (`failed`, never a silent skip). Windows: the bare name.
export function resolveSupabase({ env = process.env, home = os.homedir(), root, platform = process.platform, fallbackDirs, warn } = {}) {
  const seam = stacksSeam('PIPELINE_SUPABASE', env, { root, home, ...(warn ? { warn } : {}) });
  if (seam !== undefined && String(seam).trim() !== '') return String(seam).trim();
  if (platform === 'win32') return 'supabase';
  return findOnPosixPath('supabase', env?.PATH, fallbackDirs ?? ['/opt/homebrew/bin', '/usr/local/bin']) ?? 'supabase';
}

const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0] ?? '';
const NO_SUCH_OBJECT = /no such (object|container)/i;
const NO_SUCH_VOLUME = /no such volume/i;

// 'running' | 'stopped' | 'absent' | { unknown: reason } for the generation container.
function containerState(run, docker, id) {
  let r;
  try {
    r = run(docker, ['inspect', id], { timeoutMs: INSPECT_TIMEOUT_MS });
  } catch (err) {
    return { unknown: `docker inspect could not run: ${err?.message ?? err}` };
  }
  if (!r || r.timedOut || r.signal) return { unknown: 'docker inspect timed out or was killed' };
  if (r.code !== 0) {
    return NO_SUCH_OBJECT.test(String(r.stderr ?? '')) ? 'absent' : { unknown: `docker inspect exit ${r.code}: ${firstLine(r.stderr)}` };
  }
  let list;
  try {
    list = JSON.parse(String(r.stdout ?? ''));
  } catch {
    return { unknown: 'docker inspect output is not JSON' };
  }
  if (!Array.isArray(list)) return { unknown: 'docker inspect output is not a list' };
  const c = list.find((x) => x && String(x.Id ?? '').startsWith(id)) ?? null;
  if (!c) return 'absent';
  return c.State?.Running === true ? 'running' : 'stopped';
}

// 'present' | 'missing' | { unknown: reason }
function volumeState(run, docker, name) {
  let r;
  try {
    r = run(docker, ['volume', 'inspect', name], { timeoutMs: INSPECT_TIMEOUT_MS });
  } catch (err) {
    return { unknown: `docker volume inspect could not run: ${err?.message ?? err}` };
  }
  if (!r || r.timedOut || r.signal) return { unknown: 'docker volume inspect timed out or was killed' };
  if (r.code === 0) return 'present';
  return NO_SUCH_VOLUME.test(String(r.stderr ?? '')) ? 'missing' : { unknown: `docker volume inspect exit ${r.code}: ${firstLine(r.stderr)}` };
}

// stopStack({ stack, mode, modeKey, reassess, root, run, docker, supabaseBin, acquire, release, log, now, home, ... })
//   stack      the Stack that was assessed (inventory.mjs); stack.workdir is its realpath, stack.generation the assessed container
//   mode       'report' | 'apply': the caller's mode for this source; `modeKey` names it in mode.json (sessionEnd | sweeper)
//   reassess   async () => { verdict, reasons, current } run under the lock: re-inventory + the caller's verdict; `current` is the
//              binding state read now (decide.mjs checkBinding input), plus optional `dbVolume`
//   run        proc.mjs `run`-shaped; docker calls go to `docker`, the one mutating call to `supabaseBin`
//   lockWaitMs / pollMs   how long to wait for the project lock (default 60 s)
//   afterLock / beforeMutate   test-only seams (a pause inside the lock; a change between reassess and the call)
// -> { action: 'stopped' | 'would-stop' | 'kept' | 'failed' | 'already-stopped' | 'skipped-lock', reasons, post?, alert? }
export async function stopStack({
  stack, mode, modeKey = 'sessionEnd', reassess, root, run = realRun, docker = 'docker', supabaseBin,
  acquire = realAcquire, release = realRelease, log = () => {}, now = Date.now, home = os.homedir(),
  lockWaitMs = LOCK_WAIT_MS, pollMs = 1000, afterLock, beforeMutate, realpath = fs.realpathSync,
} = {}) {
  const files = root ? stackFiles(root) : null;
  const done = (action, reasons, extra = {}) => {
    const result = { action, reasons: [...reasons], ...extra };
    try {
      log({ t: new Date(now()).toISOString(), project: stack?.project, generation: stack?.generation ?? null, mode, ...result });
    } catch {
      /* the decision log is best effort; never let it undo or hide what happened */
    }
    return result;
  };
  const kept = (...reasons) => done('kept', reasons);

  if (!stack || typeof stack.project !== 'string' || stack.project === '') return kept('no stack to stop');
  if (typeof reassess !== 'function') return kept('no reassess function: cannot re-check');
  if (!files) return kept('no state root');

  let lock;
  try {
    lock = await acquire(projectLockName(stack.project), { dir: lockDirs(root).project, waitMs: lockWaitMs, pollMs });
  } catch (err) {
    return done('skipped-lock', [err instanceof LockTimeoutError ? `project lock busy for ${Math.round(lockWaitMs / 1000)} s: skipped` : `project lock failed: ${err?.message ?? err}`]);
  }
  try {
    await afterLock?.();

    // 1. already stopped (or removed: the Supabase CLI removes its containers on stop)?
    const genId = stack.generation?.id;
    if (!genId) return kept('assessed generation unknown');
    const before = containerState(run, docker, genId);
    if (before.unknown) return kept(`container state unknown: ${before.unknown}`);
    if (before !== 'running') return done('already-stopped', [`db container ${before === 'absent' ? 'is gone' : 'is not running'}`]);

    // 2. the verdict and the binding, read now
    let r;
    try {
      r = await reassess();
    } catch (err) {
      return kept(`re-check failed: ${err?.message ?? err}`);
    }
    if (!r || typeof r !== 'object') return kept('re-check returned nothing');
    if (r.verdict !== 'stop') return kept(...(Array.isArray(r.reasons) && r.reasons.length ? r.reasons : [`re-check verdict ${r.verdict ?? 'unknown'}`]));
    const binding = checkBinding(stack, r.current);
    if (!binding.ok) return kept(...binding.reasons);

    // 3. the workdir, as a real path that is still the assessed one
    let workdirReal;
    try {
      workdirReal = realpath(stack.workdir);
    } catch {
      return kept('workdir does not exist (report-only)');
    }
    if (workdirReal !== stack.workdir) return kept(`workdir realpath ${workdirReal} != assessed ${stack.workdir}`);

    // 4. the database volume must be known before anything is stopped
    const dbVolume = r.current?.dbVolume ?? stack.dbVolume ?? null;
    if (typeof dbVolume !== 'string' || dbVolume === '') return kept('db volume unknown');

    // 5. fresh gates, right before the call
    await beforeMutate?.();
    const blockers = [];
    if (isPaused(files.pause)) blockers.push('paused');
    if (loadMachineConfig(files.config, { home }).status !== 'ok') blockers.push('not configured');
    const fileMode = loadModes(files.mode)[modeKey];
    if (blockers.length) return kept(...blockers);
    if (mode !== 'apply') return done('would-stop', ['mode report'], { workdir: workdirReal, dbVolume });
    if (fileMode !== 'apply') return kept('mode report');

    // 6. the one mutating call, exactly once
    const args = stopArgs(workdirReal);
    if (!supabaseBin) return done('failed', ['supabase binary not found']);
    let s;
    try {
      s = run(supabaseBin, args, { timeoutMs: STOP_TIMEOUT_MS });
    } catch (err) {
      return done('failed', [`supabase stop could not run: ${err?.message ?? err}`]);
    }
    if (!s || s.timedOut || s.signal || s.code !== 0) {
      const why = !s ? 'no result' : s.timedOut ? 'timed out' : s.signal ? `ended by signal ${s.signal}` : firstLine(s.stderr) || `exit ${s.code}`;
      return done('failed', [`supabase stop failed: ${why}`]);
    }

    // 7. post-check
    const after = containerState(run, docker, genId);
    const vol = volumeState(run, docker, dbVolume);
    const post = { container: typeof after === 'string' ? after : 'unknown', dbVolume, volumePresent: vol === 'present' ? true : vol === 'missing' ? false : null };
    if (after === 'running') return done('failed', ['supabase stop returned 0 but the db container is still running'], { post });
    if (vol === 'missing') return done('stopped', [`db volume ${dbVolume} is missing after the stop`], { post, alert: 'db-volume-missing' });
    if (after.unknown || vol.unknown) return done('stopped', [`post-check incomplete: ${after.unknown ?? vol.unknown}`], { post, alert: 'post-check-unknown' });
    return done('stopped', ['stopped'], { post });
  } finally {
    try {
      release(lock);
    } catch {
      /* a failed release must not hide the decision; a stale lock is reclaimed by its dead owner check */
    }
  }
}
