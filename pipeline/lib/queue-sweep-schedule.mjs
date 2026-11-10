// The LaunchAgent `com.claude-pipeline.queue-sweep`: runs `pipeline queue-sweep` every 10 minutes and at load, so a queued PR is carried to its end even when no
// session is alive. Built with the same helpers as the stacks sweep's agent (lib/schedule.mjs schedulePlist / applyLaunchd) and removed the same way
// (lib/stacks/uninstall.mjs). The installer writes it (install), health-checks it (--check) and removes it (--uninstall).
// It belongs to the machine, not to a claude-home: only the user's own ~/.claude, with no isolated stacks root set, ever touches it. macOS only: another
// platform gets `applicable: false`.
// Everything outside the process is injectable (launchd, PATH lookup), so tests never touch a real launchd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, samePath } from './paths.mjs';
import { DARWIN_TZ_SOURCES, applyLaunchd, detectTimezone, findOnPath, scheduleLabel, schedulePlist, systemLaunchctl } from './schedule.mjs';
import { pruneLogDir } from './worktree-prune/run.mjs';

export const QUEUE_SWEEP_NAME = 'queue-sweep';
export const QUEUE_SWEEP_LABEL = scheduleLabel(QUEUE_SWEEP_NAME);
export const QUEUE_SWEEP_INTERVAL_S = 600;
const JOB_TOOLS = ['git', 'gh']; // the job's own PATH is minimal: the dirs of node, git and gh as found at install time

const safeSame = (a, b) => { try { return samePath(canonicalPath(a), canonicalPath(b)); } catch { return false; } };
export const queueSweepPlistPath = (userHome = os.homedir()) => path.join(userHome, 'Library', 'LaunchAgents', `${QUEUE_SWEEP_LABEL}.plist`);

// { applicable: true } | { applicable: false, why }
export function queueSweepApplies({ home, env = process.env, platform = process.platform, userHome = os.homedir() }) {
  if (platform !== 'darwin') return { applicable: false, why: 'the queue-sweep LaunchAgent is only managed on macOS' };
  if (env.PIPELINE_STACKS_HOME) return { applicable: false, why: 'an isolated run (PIPELINE_STACKS_HOME is set) never touches the machine schedule' };
  if (!safeSame(home, path.join(userHome, '.claude'))) return { applicable: false, why: `${home} is not the user's own ~/.claude: the machine schedule is left alone` };
  return { applicable: true };
}

// The plist for a claude-home: the installed CLI (<home>/pipeline/bin/pipeline.mjs) runs `queue-sweep`.
export function queueSweepPlist({ home, userHome = os.homedir(), env = process.env, nodePath = process.execPath, which = (cmd) => findOnPath(cmd, env.PATH) }) {
  const found = JOB_TOOLS.map((t) => [t, which(t)]);
  const logDir = pruneLogDir(env);
  return {
    plist: schedulePlist({
      nodePath, binPath: path.join(home, 'pipeline', 'bin', 'pipeline.mjs'), root: userHome, label: QUEUE_SWEEP_LABEL, interval: QUEUE_SWEEP_INTERVAL_S,
      args: [QUEUE_SWEEP_NAME], pathDirs: [...new Set([nodePath, ...found.map(([, p]) => p).filter(Boolean)].map((p) => path.dirname(p)))],
      logFile: path.join(logDir, `cron-${QUEUE_SWEEP_NAME}.log`),
    }),
    logDir,
    notFound: found.filter(([, p]) => !p).map(([t]) => t),
  };
}

// action: 'install' | 'remove' | 'status'. -> { applicable, ... } ; install/remove/status fields as applyLaunchd returns them. Never throws: a failure is `error`.
export function queueSweepSchedule({
  action, home, env = process.env, platform = process.platform, userHome = os.homedir(), uid = process.getuid?.(), launchctlFn = systemLaunchctl,
  nodePath, which, tzFn = () => detectTimezone(DARWIN_TZ_SOURCES),
}) {
  const gate = queueSweepApplies({ home, env, platform, userHome });
  if (!gate.applicable) return gate;
  const plistPath = queueSweepPlistPath(userHome);
  try {
    if (action !== 'install') {
      if (action === 'remove' && !fs.existsSync(plistPath)) return { applicable: true, removed: false };
      return { applicable: true, ...applyLaunchd({ action, plistPath, label: QUEUE_SWEEP_LABEL, launchctlFn, uid }) };
    }
    const built = queueSweepPlist({ home, userHome, env, ...(nodePath ? { nodePath } : {}), ...(which ? { which } : {}) });
    fs.mkdirSync(built.logDir, { recursive: true });
    const result = applyLaunchd({ action, plist: built.plist, plistPath, label: QUEUE_SWEEP_LABEL, launchctlFn, tzFn, uid });
    return { applicable: true, ...result, ...(built.notFound.length ? { notFound: built.notFound } : {}) };
  } catch (err) {
    return { applicable: true, error: err?.output?.message ?? err?.message ?? String(err) };
  }
}
