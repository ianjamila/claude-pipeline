// Why: what `node install.mjs --uninstall` does about stack-stop BEFORE it removes the hooks and files (docs/specs/2026-10-19-stack-stop-design.md).
// Once the hooks are gone nothing registers a use of a stack any more, but a detached SessionEnd worker may still be deciding, and the
// daily sweep may be scheduled. So: (1) touch <stacks root>/pause so no worker or sweep stops anything from now on, (2) wait up to two
// minutes for the workers listed in <root>/workers/*.json to exit and report the ones that did not, (3) remove the sweep schedule (launchd
// plist / cron line) when it exists. Nothing else is touched: never a stack, a volume, the ledger, the config or the modes.
//
// Which root: PIPELINE_STACKS_HOME when set (an isolated run), else <claude-home>/pipeline-state/stacks, i.e. the default root of the
// home being uninstalled (that is ~/.claude/pipeline-state/stacks for a normal install). A scratch --claude-home therefore never reaches
// the real state. The schedule belongs to the machine, not to a home: it is removed only when this home IS the user's ~/.claude and no
// isolated root is set.
//
// Everything outside the process is injectable (wait, clock, liveness, launchd, cron), so tests never touch a real one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath, canonicalPath } from '../paths.mjs';
import { applyLaunchd, applySchedule, scheduleLabel, scheduleMarker, systemCrontab, systemLaunchctl } from '../schedule.mjs';
import { stackFiles, stacksRoot } from './paths.mjs';

export const SCHEDULE_NAME = 'stacks-sweep';
export const WORKER_WAIT_MS = 120_000;
const POLL_MS = 500;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const defaultSleep = (ms) => Atomics.wait(sleepBuffer, 0, 0, ms);
// kill(pid, 0): ESRCH = gone; EPERM = alive (someone else's); any other answer = alive (never read an unclear answer as "gone").
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

const safeSame = (a, b) => { try { return samePath(canonicalPath(a), canonicalPath(b)); } catch { return false; } };

export function uninstallStacksRoot({ home, env = process.env }) {
  if (env.PIPELINE_STACKS_HOME) return stacksRoot(env, os.homedir());
  return path.join(home, 'pipeline-state', 'stacks');
}

// pids named by workers/*.json (the file name is the worker's pid); files that do not look like <pid>.json are ignored.
function workerPids(workersDir, fsx) {
  let names;
  try { names = fsx.readdirSync(workersDir); } catch { return []; }
  return names.map((n) => /^(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter((n) => n > 0).sort((a, b) => a - b);
}

// -> { root, existed, paused, workers: { waitedMs, survivors: [pid] }, schedule: { removed, error? }, warnings: [] }. Never throws.
export function stacksUninstall({
  home, env = process.env, platform = process.platform, userHome = os.homedir(), uid = process.getuid?.(),
  waitMs = WORKER_WAIT_MS, now = Date.now, sleep = defaultSleep, isAlive = defaultIsAlive,
  launchctlFn = systemLaunchctl, crontabFn = systemCrontab, fsx = fs,
} = {}) {
  const warnings = [];
  const out = { root: null, existed: false, paused: false, workers: { waitedMs: 0, survivors: [] }, schedule: { removed: false }, warnings };
  if (platform === 'win32') return out; // stacks are not supported on Windows: nothing was ever written
  const root = uninstallStacksRoot({ home, env });
  out.root = root;
  const files = stackFiles(root);

  let rootIsDir = false;
  try { rootIsDir = fsx.statSync(root).isDirectory(); } catch { rootIsDir = false; }
  out.existed = rootIsDir;
  if (rootIsDir) {
    try {
      fsx.writeFileSync(files.pause, `${new Date(now()).toISOString()} paused by install.mjs --uninstall\n`, { flag: 'a' });
      out.paused = true;
    } catch (err) {
      warnings.push(`could not create ${files.pause} (${err?.code ?? err?.message}); a running stack-stop worker is not paused`);
    }
    const started = now();
    let pids = workerPids(files.workers, fsx);
    let alive = pids.filter((p) => isAlive(p));
    while (alive.length > 0 && now() - started < waitMs) {
      sleep(Math.min(POLL_MS, Math.max(1, waitMs - (now() - started))));
      alive = alive.filter((p) => isAlive(p));
    }
    out.workers = { waitedMs: Math.max(0, now() - started), survivors: alive };
    if (alive.length > 0) warnings.push(`stack-stop worker${alive.length === 1 ? '' : 's'} still running after ${Math.round(waitMs / 1000)} s: pid ${alive.join(', ')} (${files.pause} is in place, so nothing will be stopped)`);
  }

  // The schedule is the machine's: only for the user's own ~/.claude and the default root.
  const standardHome = !env.PIPELINE_STACKS_HOME && safeSame(home, path.join(userHome, '.claude'));
  if (standardHome) {
    try {
      const label = scheduleLabel(SCHEDULE_NAME);
      if (platform === 'darwin') {
        const plistPath = path.join(userHome, 'Library', 'LaunchAgents', `${label}.plist`);
        if (fsx.existsSync(plistPath)) out.schedule = { removed: applyLaunchd({ action: 'remove', plistPath, label, launchctlFn, uid }).removed === true };
      } else {
        const marker = scheduleMarker(SCHEDULE_NAME, 'stacks');
        let present = false;
        try { present = applySchedule({ action: 'status', marker, crontabFn }).installed; } catch { present = false; }
        if (present) out.schedule = { removed: applySchedule({ action: 'remove', marker, crontabFn }).removed === true };
      }
    } catch (err) {
      const message = err?.output?.message ?? err?.message ?? String(err);
      out.schedule = { removed: false, error: message };
      warnings.push(`could not remove the ${scheduleLabel(SCHEDULE_NAME)} schedule: ${message}`);
    }
  }
  return out;
}
