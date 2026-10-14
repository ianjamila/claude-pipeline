// One per-user macOS LaunchAgent: plist text, install, remove, status. The launchctl runner, home directory and uid are
// injected, so tests never touch launchd. The semantics match the worktrees LaunchAgent (open PR #64) so the two can share
// this module later: the plist is written only when its text differs; install is `launchctl bootout gui/<uid>/<label>`
// (a "not loaded" failure is ignored) then `launchctl bootstrap gui/<uid> <plist>` (a failing bootstrap is exit 2
// {error: 'launchctl'}); remove boots out, CONFIRMS with `launchctl print` that the job is gone, and only then deletes the
// plist; status `installed` = plist exists AND `print` succeeds. Failures are Fail (cmd-common), turned into results by guarded().
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { run as runProc } from './proc.mjs';

// By absolute path, so a PATH without /bin cannot make it "not found" (a spawn failure reads as non-zero with "spawn ... ENOENT",
// which absentJob() below refuses to take as "unloaded").
export const LAUNCHCTL = '/bin/launchctl';
export const systemLaunchctl = (args) => runProc(LAUNCHCTL, args);

export const agentPlistPath = (home, label) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const str = (v, pad) => `${pad}<string>${xmlEscape(v)}</string>`;

// The plist text, deterministic so an unchanged install leaves the file alone. `startInterval` is seconds (positive integer).
export function plistText({ label, programArguments, searchPath, startInterval, runAtLoad = false, logFile, workingDirectory }) {
  const all = [label, ...programArguments, searchPath, logFile, workingDirectory ?? ''];
  if (all.some((p) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p))) throw new Fail(EXIT.USAGE, { ok: false, error: 'usage', message: 'schedule: a path contains a control character, which a plist cannot hold' });
  if (!Number.isInteger(startInterval) || startInterval < 1) throw new Error(`startInterval must be a positive integer, got ${startInterval}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str(label, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((a) => str(a, '    ')),
    '  </array>',
    ...(workingDirectory ? ['  <key>WorkingDirectory</key>', str(workingDirectory, '  ')] : []),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    str(searchPath, '    '),
    '  </dict>',
    '  <key>StartInterval</key>',
    `  <integer>${startInterval}</integer>`,
    '  <key>StandardOutPath</key>',
    str(logFile, '  '),
    '  <key>StandardErrorPath</key>',
    str(logFile, '  '),
    '  <key>RunAtLoad</key>',
    runAtLoad ? '  <true/>' : '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// `launchctl print` CONFIRMS a job is not loaded only by exit 113 or by saying "Could not find service". Any other non-zero
// (launchctl missing, a permission or domain error) tells nothing about the job, so it is never read as "unloaded".
export const absentJob = (r) => r.code === 113 || /could not find service/i.test(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);
const why = (r) => r.stderr?.trim() || `exit ${r.code}`;
const launchctlFail = (message) => new Fail(EXIT.USAGE, { ok: false, error: 'launchctl', message });

// Writes `text` to `plistPath` only when it differs. -> whether it wrote.
export function writePlist(plistPath, text) {
  let before = null;
  try { before = readFileSync(plistPath, 'utf8'); } catch { /* no plist yet */ }
  if (before === text) return false;
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, text);
  return true;
}

// Always reloads, even when the file is unchanged: that also repairs a job that is not loaded (after a remove by hand).
export function install({ plist, plistPath, label, launchctl = systemLaunchctl, uid }) {
  const domain = `gui/${uid}`;
  const changed = writePlist(plistPath, plist);
  launchctl(['bootout', `${domain}/${label}`]); // the result is only read by a failing bootstrap below
  const r = launchctl(['bootstrap', domain, plistPath]);
  if (r.code !== 0) throw launchctlFail(`cannot load the LaunchAgent: ${r.stderr?.trim() || `exit ${r.code}`}`);
  return { changed };
}

// Boots the job out, asks `print` whether it is really gone, and deletes the plist only when that is CONFIRMED.
export function remove({ plistPath, label, launchctl = systemLaunchctl, uid }) {
  const target = `gui/${uid}/${label}`;
  const out = launchctl(['bootout', target]);
  const probe = launchctl(['print', target]);
  if (probe.code === 0) throw launchctlFail(`could not unload ${label}: ${why(out)}`);
  if (!absentJob(probe)) throw launchctlFail(`could not confirm ${label} is unloaded: ${why(probe)}`);
  const had = existsSync(plistPath);
  if (had) rmSync(plistPath);
  return { removed: had };
}

// `installed` = the plist exists AND launchd has it loaded; `line` is the plist path (null when it is missing).
export function status({ plistPath, label, launchctl = systemLaunchctl, uid }) {
  const exists = existsSync(plistPath);
  const probe = launchctl(['print', `gui/${uid}/${label}`]);
  const loaded = probe.code === 0;
  const out = { installed: exists && loaded, line: exists ? plistPath : null, plist: plistPath, loaded };
  if (!loaded && !absentJob(probe)) out.warning = `could not tell whether ${label} is loaded: ${why(probe)}`;
  return out;
}
