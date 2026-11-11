#!/usr/bin/env node
// Why: one installer for macOS and Windows that copies the pipeline's skills, agents and CLI into ~/.claude and
// registers its two safety hooks (plus the owner-go recorder and the three stack-stop hooks) in settings.json without
// disturbing anything else the owner has there. Units this version no longer ships (I.RETIRED_SKILLS, I.RETIRED_HOOKS) are removed
// from an existing install by the next run.
// It is idempotent, refuses to overwrite files it did not install, and refuses to run inside a Claude Code
// session (an agent must not be able to reinstall or remove its own guards) unless PIPELINE_ADMIN=1. "Inside" means
// CLAUDECODE=1 in the environment OR a Claude Code ancestor process (the variable can be stripped, the parent cannot).
// All decisions live in pipeline/lib/installer.mjs; this file does the disk work, the report and the exit code.
// PIPELINE_INSTALL_NO_PROBES=1 skips the claude/codex/gh version probes (tests and CI).
// PIPELINE_INSTALL_RETIRED_SKILLS=a,b (a test seam: honoured only with PIPELINE_TEST_MODE=1, like the other seams) adds skill names to I.RETIRED_SKILLS.
// --require-no-live-reviews (the unattended `pipeline update --scheduled`, plan 2026-11-10 B1): see "admission" below. Exit codes: 0 ok, 1 failed (also a
// failed own verification, and an --expect-installed mismatch), 2 refused (usage, wrong home, inside Claude Code), 3 deferred (something is live, the scan
// overran its deadline, or another update holds admission). Test seams, all honoured only by a checkout WITH PIPELINE_TEST_MODE=1:
//   PIPELINE_INSTALL_ACCOUNT_HOME=DIR   stands in for the account's home in the --require-no-live-reviews home check
//   PIPELINE_INSTALL_SCAN_DELAY_MS=N    sleep N ms before the live-work scan (proves the deadline)
//   PIPELINE_INSTALL_SWAP_GATE=DIR      just before the first unit swap, write DIR/reached and wait (up to 60 s) for DIR/go
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { run, seamFlag, seamValue } from './pipeline/lib/proc.mjs';
import { accountHome, canonicalPath, expandHome, isInside, safeTimestamp, samePath } from './pipeline/lib/paths.mjs';
// `pipeline update` (commands/update.mjs installerAcceptsPrivateTmpSource) detects this import to know the installer accepts its download.
import { TMP_ROOT_REL } from './pipeline/lib/private-tmp.mjs';
import * as I from './pipeline/lib/installer.mjs';
import { hasClaudeCodeAncestor } from './pipeline/lib/claude-ancestry.mjs';
import { tryAcquire, release } from './pipeline/lib/locks.mjs';
import { fileProvenance, installedIdentity } from './pipeline/lib/identity.mjs';
import { ScanDeadline, scanLiveWork } from './pipeline/lib/live-work-scan.mjs';
import { acquireAdmission, releaseAdmission, sweepDeadLeases } from './pipeline/lib/review-lease.mjs';
import { stacksUninstall } from './pipeline/lib/stacks/uninstall.mjs';
import { stacksSeam } from './pipeline/lib/stacks/paths.mjs';
import { queueSweepSchedule } from './pipeline/lib/queue-sweep-schedule.mjs';

class InstallError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

// ---- settings.json -----------------------------------------------------------------------------------------

// { file, exists, settings, problem }. Strict mode throws on an unreadable or invalid file; lenient returns the problem.
function readSettings(home, { lenient = false } = {}) {
  const file = path.join(home, 'settings.json');
  const fail = (message) => {
    if (lenient) return { file, exists: true, settings: null, problem: message };
    throw new InstallError(`${message}. Nothing was changed; fix or move the file and re-run.`);
  };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { file, exists: false, settings: {}, problem: null };
    return fail(`cannot read ${file}: ${err.message}`);
  }
  try {
    return { file, exists: true, settings: JSON.parse(text.replace(/^﻿/, '')), problem: null };
  } catch (err) {
    return fail(`${file} is not valid JSON (${err.message})`);
  }
}

function shapeChecked(fn, file) {
  try { return fn(); } catch (err) {
    if (err instanceof I.SettingsShapeError) throw new InstallError(`${file}: ${err.message}. Nothing was changed.`);
    throw err;
  }
}

// Copy of the current settings.json into <home>/backups. A name clash (two runs in the same second) moves
// to the next second instead of overwriting, so an earlier backup is never lost.
function backupSettings(home, file) {
  const dir = path.join(home, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const start = Date.now();
  for (let i = 0; i < 600; i++) {
    const dest = path.join(dir, `settings.json.${safeTimestamp(new Date(start + i * 1000))}`);
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new InstallError(`could not find a free backup name in ${dir}`);
}

// tmp file + rename, next to the real file (a symlinked file stays a symlink; its mode is kept).
function writeFileAtomic(file, text, exists) {
  const target = exists ? fs.realpathSync(file) : file;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    if (exists) { try { fs.chmodSync(tmp, fs.statSync(target).mode & 0o777); } catch { /* keep the default mode */ } }
    I.renameWithRetry(tmp, target);
  } catch (err) {
    rm(tmp);
    throw err;
  }
}

// ---- copying -----------------------------------------------------------------------------------------------

const writeSettingsFile = (file, settings, exists) => writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, exists);

function copyChecked(file, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file.abs, dest);
  if (I.sha256File(dest) !== file.sha256) throw new InstallError(`the copy of ${file.rel} does not match the source (did the source change while installing?)`);
}

// Stage and rollback copies live in <home>/backups/.staging/, never beside the targets: Claude Code scans
// skills/ and agents/, and a half-copied or leftover *.new-<ts> dir there would be loaded as a skill or agent.
const stagingRoot = (home) => I.fromRel(home, I.STAGING_REL);
const stagingName = (home, unit, kind, ts) => path.join(stagingRoot(home), `${unit.rel.replace(/\//g, '--')}.${kind}-${ts}`);

// Copies a unit into the staging dir as <rel>.new-<ts>. For the pipeline dir the new manifest goes in too,
// so the manifest and the files it describes switch over in the same rename.
function stageUnit(home, unit, ts, manifestText) {
  const target = I.unitTarget(home, unit);
  const staging = stagingName(home, unit, 'new', ts);
  fs.mkdirSync(stagingRoot(home), { recursive: true });
  rm(staging);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    if (unit.kind === 'agent') {
      copyChecked(unit.files[0], staging);
    } else {
      fs.mkdirSync(staging, { recursive: true });
      for (const f of unit.files) copyChecked(f, path.join(staging, ...f.rel.slice(unit.rel.length + 1).split('/')));
      if (unit.kind === 'pipeline') fs.writeFileSync(path.join(staging, 'INSTALLED.json'), manifestText);
    }
  } catch (err) {
    rm(staging);
    throw err;
  }
  return staging;
}

function uniquePath(base) {
  let candidate = base;
  for (let i = 1; I.lexists(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

// Puts the staged copy in place. Directories: rename old aside, rename new in, drop old (rolled back if the
// second rename fails). With keepOld (a foreign target under --force, or one holding the user's edits) the old
// copy is kept under backups/<name>.<ts> instead of being deleted.
function swapIn(home, unit, staging, { keepOld, ts, warnings }) {
  const target = I.unitTarget(home, unit);
  let backup = null;
  const foreignBackupPath = () => {
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    return uniquePath(path.join(home, 'backups', `${path.basename(target)}.${ts}`));
  };
  if (!I.lexists(target)) {
    I.renameWithRetry(staging, target);
    return backup;
  }
  if (unit.kind === 'agent') {
    if (keepOld) { backup = foreignBackupPath(); fs.copyFileSync(target, backup); }
    I.renameWithRetry(staging, target); // replaces the file in one step
    return backup;
  }
  const old = stagingName(home, unit, 'old', ts);
  rm(old);
  I.renameWithRetry(target, old);
  try {
    I.renameWithRetry(staging, target);
  } catch (err) {
    try { I.renameWithRetry(old, target); } catch { /* the original error is the one that matters */ }
    throw err;
  }
  if (keepOld) {
    backup = foreignBackupPath();
    I.renameWithRetry(old, backup);
  } else {
    try { rm(old); } catch (err) { warnings.push(`could not remove ${old}: ${err.message}`); }
  }
  return backup;
}

// Removes empty directories from `start` upwards, never the home itself or its skills/ and agents/ dirs.
function pruneEmptyDirs(start, home) {
  const stops = new Set([home, path.join(home, 'skills'), path.join(home, 'agents')]);
  let dir = start;
  while (!stops.has(dir) && isInside(dir, home)) {
    try { fs.rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

function removeInstalledFile(home, rel) {
  const file = I.fromRel(home, rel);
  if (!I.lexists(file)) return false;
  fs.rmSync(file, { force: true });
  pruneEmptyDirs(path.dirname(file), home);
  return true;
}

// What to record as the source commit. HEAD is only the truth when the files being copied ARE HEAD's files
// (fileProvenance in pipeline/lib/identity.mjs compares every planned file with HEAD's blobs). Anything not in HEAD or
// with another blob (an edit, a new file, an ignored extra) means no sha is recorded: { sourceSha: null, sourceDirty:
// true, warning }. Not a checkout, or git unavailable: { sourceSha: null, sourceDirty: false } as before.
function sourceProvenance(source, plan) {
  const p = fileProvenance(source, [...plan.files.values()].map((f) => f.abs), { scope: 'install' });
  if (p.state === 'no-git') return { sourceSha: null, sourceDirty: false, warning: null };
  if (p.state === 'unverifiable') return { sourceSha: null, sourceDirty: true, warning: `could not compare the source with ${p.head.slice(0, 7)}; recording no source sha` };
  if (p.state === 'clean') return { sourceSha: p.head, sourceDirty: false, warning: null };
  return {
    sourceSha: null,
    sourceDirty: true,
    warning: `source is not a clean checkout of ${p.head.slice(0, 7)}: ${p.differing.slice(0, 3).join(', ')}; recording no source sha`,
  };
}

function diagnostics(ctx, settings) {
  const probes = ctx.env.PIPELINE_INSTALL_NO_PROBES ? null : run;
  return I.collectDiagnostics({ settings, env: ctx.env, home: os.homedir(), platform: process.platform, runFn: probes });
}

// The skills to retire: the shipped list, plus (test seam, PIPELINE_TEST_MODE=1 only) names from PIPELINE_INSTALL_RETIRED_SKILLS. Only plain directory names count.
function retiredSkillNames(env) {
  const opts = { root: fileURLToPath(new URL('./pipeline', import.meta.url)) };
  const raw = seamFlag('PIPELINE_TEST_MODE', env, opts) ? seamValue('PIPELINE_INSTALL_RETIRED_SKILLS', env, opts) : undefined;
  const extra = raw === undefined ? [] : raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s));
  return [...I.RETIRED_SKILLS, ...extra];
}

// Takes the retired skills out of the install. Per unit: the files the manifest lists are removed, an owner-modified one is first
// copied to backups/<name>.<ts>/ (the name an edited unit's backup gets in swapIn, uniquified the same way); files the manifest does
// not list stay. Runs BEFORE the pipeline unit is swapped, while the old manifest still lists every file, so a run that dies half
// way is finished by the next one. Returns [{ rel, removed, backedUp, backup, kept }] for the units that had something to do.
function retireUnits(home, manifest, names, ts) {
  const report = [];
  for (const unit of I.retiredSkillUnits(names)) {
    const { listed, kept } = I.scanRetiredUnit(home, unit, manifest);
    if (listed.length === 0 && kept.length === 0) continue;
    const edited = listed.filter((f) => f.modified);
    let backup = null;
    if (edited.length > 0) {
      fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
      backup = uniquePath(path.join(home, 'backups', `${path.basename(I.unitTarget(home, unit))}.${ts}`));
      for (const f of edited) {
        const dest = I.fromRel(backup, f.rel.slice(unit.rel.length + 1));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(I.fromRel(home, f.rel), dest);
      }
    }
    const removed = [];
    for (const f of listed) if (removeInstalledFile(home, f.rel)) removed.push(f.rel);
    report.push({ rel: unit.rel, removed, backedUp: edited.map((f) => f.rel), backup, kept });
  }
  return report;
}

function loadPlan(source) {
  const plan = I.buildPlan(source);
  if (plan.problems.length > 0) throw new InstallError(`cannot install from ${source}:\n  - ${plan.problems.join('\n  - ')}`);
  return plan;
}

// ---- test seams (PIPELINE_TEST_MODE=1 and a checkout only) ------------------------------------------------------

const seamOpts = { root: fileURLToPath(new URL('./pipeline', import.meta.url)) };
const testSeam = (name, env) => (seamFlag('PIPELINE_TEST_MODE', env, seamOpts) ? seamValue(name, env, seamOpts) : undefined);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Lets a test hold the installer exactly where the swap would start: DIR/reached appears, the run waits for DIR/go (60 s at most).
function testSwapGate(env) {
  const dir = testSeam('PIPELINE_INSTALL_SWAP_GATE', env);
  if (!dir) return;
  fs.writeFileSync(path.join(dir, 'reached'), `${process.pid}\n`);
  for (let i = 0; i < 1200 && !fs.existsSync(path.join(dir, 'go')); i++) sleepSync(50);
}

// ---- install -----------------------------------------------------------------------------------------------

function doInstall(ctx) {
  const { opts, home, source } = ctx;
  const warnings = [];
  const plan = loadPlan(source);
  warnings.push(...plan.warnings);
  // `pipeline update` downloads into <home>/pipeline-state/tmp (private-tmp.mjs), a place this installer never writes to
  // (it only writes skills/, agents/, pipeline/, settings.json and backups/), so a source there cannot be overwritten.
  if (isInside(source, home) && !isInside(source, path.join(home, TMP_ROOT_REL))) throw new InstallError(`the source (${source}) is inside the claude-home (${home}); installing would overwrite it`);

  // Everything that can refuse happens before the first write.
  const current = readSettings(home);
  const merged = shapeChecked(() => I.mergeSettings(current.settings, { home, skipFileGuard: opts.skipFileGuard }), current.file);
  const { manifest, warnings: manifestWarnings } = I.readManifest(home);
  warnings.push(...manifestWarnings);
  const states = new Map(plan.units.map((u) => [u.rel, I.unitState(home, u)]));
  const conflicts = I.findConflicts({ home, plan, manifest, states });
  if (conflicts.length > 0 && !opts.force) {
    throw new InstallError(conflicts.map((rel) => `refusing to overwrite ${rel}: it exists in ${home} and was not installed by claude-pipeline (it is not listed in ${I.MANIFEST_REL}). Move it away, or re-run with --force (the old copy is kept in backups/).`).join('\n'));
  }
  const backupsExisted = I.lexists(path.join(home, 'backups'));
  const retiredNames = retiredSkillNames(ctx.env);
  const retiredRels = I.retiredSkillUnits(retiredNames).map((u) => `${u.rel}/`);
  const staleRels = Object.keys(manifest?.files ?? {}).filter((rel) => !plan.files.has(rel) && !retiredRels.some((r) => rel.startsWith(r)) && I.lexists(I.fromRel(home, rel)));

  const settingsChanged = !current.exists || !isDeepStrictEqual(merged, current.settings);
  fs.mkdirSync(home, { recursive: true });
  const backup = settingsChanged && current.exists ? backupSettings(home, current.file) : null;

  const ts = safeTimestamp();
  const retired = retireUnits(home, manifest, retiredNames, ts);
  // The pipeline unit is staged with "complete": false; only the rewrite at the very end says true, so an install
  // that dies half way never reads as current.
  const provenance = sourceProvenance(source, plan);
  if (provenance.warning) warnings.push(provenance.warning);
  const manifestObj = I.buildManifest({ plan, sourceSha: provenance.sourceSha, sourceDirty: provenance.sourceDirty, skipFileGuard: opts.skipFileGuard, complete: false });
  const manifestText = `${JSON.stringify(manifestObj, null, 2)}\n`;
  const manifestFile = I.fromRel(home, I.MANIFEST_REL);
  const anyUnitChanges = plan.units.some((u) => states.get(u.rel) !== 'same');
  let copied = 0;
  let unchanged = 0;
  const foreignBackups = [];
  const editBackups = [];
  testSwapGate(ctx.env);
  try {
    for (const unit of plan.units) {
      if (states.get(unit.rel) === 'same') {
        unchanged += unit.files.length;
        // The pipeline files stay, but a later unit is about to change: the manifest must say "unfinished" until the end.
        if (unit.kind === 'pipeline' && anyUnitChanges) writeFileAtomic(manifestFile, manifestText, I.lexists(manifestFile));
        continue;
      }
      const foreign = conflicts.includes(unit.rel);
      const edited = !foreign && I.userEditedFiles(home, unit, manifest).length > 0;
      const staging = stageUnit(home, unit, ts, manifestText);
      try {
        const kept = swapIn(home, unit, staging, { keepOld: foreign || edited, ts, warnings });
        if (kept && foreign) foreignBackups.push(kept);
        else if (kept) editBackups.push({ rel: unit.rel, backup: kept });
      } catch (err) {
        rm(staging);
        throw err;
      }
      copied += unit.files.length;
    }
  } finally {
    // The staging dir is empty after a clean run; drop it (and backups/ if this run made it and nothing went in).
    try { fs.rmdirSync(stagingRoot(home)); } catch { /* not empty or absent */ }
    if (!backupsExisted) { try { fs.rmdirSync(path.join(home, 'backups')); } catch { /* has backups in it */ } }
  }
  const removed = [];
  for (const rel of staleRels) {
    removeInstalledFile(home, rel);
    removed.push(rel);
  }

  if (settingsChanged) writeSettingsFile(current.file, merged, current.exists);

  // Everything is in place: mark the install complete. A byte-identical no-op run keeps its file (only the time differs).
  const finalObj = { ...manifestObj, complete: true };
  // (any unit change means the manifest on disk is now the staged, incomplete copy)
  const alreadyFinal = manifest && !anyUnitChanges && I.manifestComplete(manifest)
    && isDeepStrictEqual(I.manifestWithoutTime({ ...manifest, complete: true }), I.manifestWithoutTime(finalObj));
  if (!alreadyFinal) writeFileAtomic(manifestFile, `${JSON.stringify(finalObj, null, 2)}\n`, I.lexists(manifestFile));

  // The merge-queue sweep's LaunchAgent (macOS, the user's own ~/.claude only; anything else is left alone). A failure is a warning: the files are in place.
  const queueSweep = queueSweepSchedule({ action: 'install', home, env: ctx.env });
  if (queueSweep.error) warnings.push(`could not install the queue-sweep LaunchAgent: ${queueSweep.error}`);
  if (queueSweep.notFound) warnings.push(`queue-sweep LaunchAgent: ${queueSweep.notFound.join(' and ')} not found on PATH, so the job cannot find it`);

  const allowBefore = new Set(current.settings.permissions?.allow ?? []);
  return {
    ok: true,
    mode: 'install',
    home,
    source,
    version: plan.version,
    sourceSha: manifestObj.sourceSha,
    files: { total: plan.files.size, copied, unchanged, removed },
    hooks: { guardGit: true, guardFiles: !opts.skipFileGuard },
    settings: { path: current.file, created: !current.exists, changed: settingsChanged, backup },
    allow: { added: I.ourAllowEntries(home).filter((e) => !allowBefore.has(e)) },
    foreignBackups,
    editBackups,
    retired,
    queueSweep: { installed: queueSweep.installed === true, applicable: queueSweep.applicable },
    warnings,
    diagnostics: diagnostics(ctx, merged),
  };
}

// ---- check -------------------------------------------------------------------------------------------------

function doCheck(ctx) {
  const { opts, home, source } = ctx;
  const plan = loadPlan(source);
  const current = readSettings(home, { lenient: true });
  let problem = current.problem;
  if (!problem && current.exists) {
    try { I.mergeSettings(current.settings, { home }); } catch (err) {
      if (!(err instanceof I.SettingsShapeError)) throw err;
      problem = err.message;
    }
  }
  const { manifest, warnings } = I.readManifest(home);
  const drift = I.computeDrift({
    home,
    plan,
    manifest,
    settings: current.exists ? current.settings : null,
    settingsProblem: problem,
    skipFileGuard: opts.skipFileGuard,
    retiredSkills: retiredSkillNames(ctx.env),
  });
  // The merge-queue sweep's LaunchAgent must be written and loaded (macOS, the user's own ~/.claude).
  const queueSweep = queueSweepSchedule({ action: 'status', home, env: ctx.env });
  if (queueSweep.applicable && queueSweep.installed !== true) {
    drift.push({ kind: 'schedule', path: queueSweep.plist ?? 'com.claude-pipeline.queue-sweep', message: `the queue-sweep LaunchAgent is not ${queueSweep.line ? 'loaded' : 'installed'}: re-run the installer` });
  }
  return { ok: drift.length === 0, mode: 'check', home, source, version: plan.version, installedVersion: manifest?.version ?? null, drift, warnings: [...plan.warnings, ...warnings] };
}

// ---- uninstall ---------------------------------------------------------------------------------------------

// Test seam for the worker wait (default 120 s); honoured only for an isolated stacks run (PIPELINE_STACKS_HOME + PIPELINE_STACKS_ONLY).
function workerWaitMs(env) {
  const raw = stacksSeam('PIPELINE_INSTALL_WORKER_WAIT_MS', env, { root: fileURLToPath(new URL('./pipeline', import.meta.url)) });
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function doUninstall(ctx) {
  const { home } = ctx;
  const warnings = [];
  const current = readSettings(home);
  const stripped = shapeChecked(() => I.removeOurSettings(current.settings, { home }), current.file);
  const { manifest, warnings: manifestWarnings } = I.readManifest(home);
  warnings.push(...manifestWarnings);

  // Stack-stop first: pause it, let a running worker finish, drop its schedule (never touches stacks, volumes, ledger, config or modes).
  const waitMs = workerWaitMs(ctx.env);
  const stacks = stacksUninstall({ home, env: ctx.env, ...(waitMs !== undefined ? { waitMs } : {}) });
  warnings.push(...stacks.warnings);

  const queueSweep = queueSweepSchedule({ action: 'remove', home, env: ctx.env });
  if (queueSweep.error) warnings.push(`could not remove the queue-sweep LaunchAgent: ${queueSweep.error}`);

  const found = I.inspectHooks(current.settings, home);
  const hookCount = Object.values(found).reduce((n, list) => n + list.length, 0);
  const allowBefore = new Set(current.settings.permissions?.allow ?? []);
  const allowRemoved = I.ourAllowEntries(home).filter((e) => allowBefore.has(e));
  const settingsChanged = current.exists && !isDeepStrictEqual(stripped, current.settings);
  let backup = null;
  if (settingsChanged) {
    backup = backupSettings(home, current.file);
    writeSettingsFile(current.file, stripped, true);
  }

  const removed = [];
  for (const rel of Object.keys(manifest?.files ?? {})) if (removeInstalledFile(home, rel)) removed.push(rel);
  if (manifest) removeInstalledFile(home, I.MANIFEST_REL);
  for (const left of ['pipeline', ...I.SKILLS.map((s) => `skills/${s}`)]) {
    if (I.lexists(I.fromRel(home, left))) warnings.push(`left ${left}/ in place: it holds files that claude-pipeline did not install`);
  }
  return {
    ok: true,
    mode: 'uninstall',
    home,
    files: { removed },
    hooks: { removed: hookCount },
    allow: { removed: allowRemoved },
    settings: { path: current.file, changed: settingsChanged, backup },
    stacks: { root: stacks.root, paused: stacks.paused, workersSurvived: stacks.workers.survivors, scheduleRemoved: stacks.schedule.removed },
    queueSweep: { removed: queueSweep.removed === true },
    warnings,
  };
}

// ---- report ------------------------------------------------------------------------------------------------

const MAX_DRIFT_LINES = 40;

function formatDiagnostics(d) {
  const lines = ['', 'Diagnostics', '  CLAUDE_CODE_SUBAGENT_MODEL'];
  const m = d.subagentModel;
  lines.push(`    settings.json env: ${m.settingsEnv ?? 'not set'}`);
  lines.push(`    process env:       ${m.processEnv ?? 'not set'}`);
  if (m.shellFiles.length === 0) lines.push('    shell files:       not set in any checked profile');
  for (const hit of m.shellFiles) lines.push(`    shell file:        ${hit.file}:${hit.line}  ${hit.text}`);
  lines.push(`    note: ${d.note}`);
  if (d.versions) {
    lines.push('  Tool versions');
    for (const [tool, version] of Object.entries(d.versions)) lines.push(`    ${tool}: ${version}`);
  }
  return lines;
}

function formatReport(r) {
  const lines = [];
  if (r.mode === 'install') {
    lines.push(`claude-pipeline ${r.version} installed in ${r.home}`);
    lines.push(`  files:     ${r.files.copied} copied, ${r.files.unchanged} unchanged, ${r.files.removed.length} removed`);
    for (const rel of r.files.removed) lines.push(`             removed ${rel}`);
    lines.push(`  hooks:     guard-git yes, guard-files ${r.hooks.guardFiles ? 'yes' : 'no (--skip-file-guard)'}, stack-stop yes (stack-register PreToolUse, stack-dev-bind PostToolUse, stack-session-end SessionEnd)`);
    const state = r.settings.created ? 'created' : r.settings.changed ? 'updated' : 'unchanged';
    lines.push(`  settings:  ${r.settings.path} ${state}`);
    lines.push(`  backup:    ${r.settings.backup ?? 'none (settings.json was not changed or did not exist)'}`);
    lines.push(`  allow:     ${r.allow.added.length === 0 ? 'entries already present' : `added ${r.allow.added.join(', ')}`}`);
    for (const b of r.foreignBackups) lines.push(`  replaced a file that was not ours; the old copy is at ${b}`);
    for (const b of r.editBackups) lines.push(`  your edits in ${b.rel} were replaced; the old copy is at ${b.backup}`);
    for (const u of r.retired) {
      lines.push(`  retired ${u.rel}/: ${u.removed.length} file${u.removed.length === 1 ? '' : 's'} removed (no longer part of claude-pipeline)`);
      if (u.backup) lines.push(`    your edits in ${u.backedUp.join(', ')} were saved; the old copy is at ${u.backup}`);
      for (const k of u.kept) lines.push(`    kept ${k}: claude-pipeline did not install it`);
    }
    if (r.queueSweep?.installed) lines.push('  queue:     sweep LaunchAgent com.claude-pipeline.queue-sweep installed (every 10 minutes)');
    if (r.verify) {
      lines.push(`  verify:    ${r.verify.ok ? 'no drift' : `DRIFT after the install (${r.verify.drift.length})`}`);
      for (const d of r.verify.drift.slice(0, MAX_DRIFT_LINES)) lines.push(`    - ${d.message}`);
    }
    lines.push(...formatDiagnostics(r.diagnostics));
  } else if (r.mode === 'uninstall') {
    lines.push(`claude-pipeline uninstalled from ${r.home}`);
    lines.push(`  files:     ${r.files.removed.length} removed`);
    lines.push(`  hooks:     ${r.hooks.removed} removed from settings.json`);
    lines.push(`  allow:     ${r.allow.removed.length} entries removed`);
    if (r.stacks?.paused) lines.push(`  stacks:    paused (${r.stacks.root}/pause is left in place; delete it to resume)${r.stacks.scheduleRemoved ? ', sweep schedule removed' : ''}`);
    else if (r.stacks?.scheduleRemoved) lines.push('  stacks:    sweep schedule removed');
    if (r.queueSweep?.removed) lines.push('  queue:     sweep LaunchAgent removed');
    lines.push(`  backup:    ${r.settings.backup ?? 'none (settings.json did not change)'}`);
  } else if (r.ok) {
    lines.push(`No drift: claude-pipeline ${r.installedVersion ?? r.version} in ${r.home} matches ${r.source} and settings.json.`);
  } else {
    lines.push(`Drift in ${r.home} (source ${r.source}, version ${r.version}):`);
    for (const d of r.drift.slice(0, MAX_DRIFT_LINES)) lines.push(`  - ${d.message}`);
    if (r.drift.length > MAX_DRIFT_LINES) lines.push(`  ... and ${r.drift.length - MAX_DRIFT_LINES} more (use --json for the full list)`);
    lines.push('Re-run the installer (in your own terminal) to bring it back in line.');
  }
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
  return `${lines.join('\n')}\n`;
}

// ---- write lock --------------------------------------------------------------------------------------------

// Install and uninstall (not --check) hold one lock per claude-home for the whole write run, so two of them can never
// interleave their swaps. locks.mjs reclaims a lock whose owner process is dead; a live owner (or another machine's)
// is never touched. The lock lives in <home>/backups/.locks, named for the home's canonical (symlink-resolved) path, so
// an alias of the home cannot dodge it; PIPELINE_LOCK_DIR moves the lock directory (tests). `pipeline update` runs this
// installer as a child and takes no lock of its own, so it cannot deadlock against it.
function takeWriteLock(home, env) {
  let got;
  try {
    got = tryAcquire(I.installLockName(home), { dir: env.PIPELINE_LOCK_DIR || I.installLockDir(home) });
  } catch (err) {
    throw new InstallError(`could not take the install lock: ${err?.message ?? err}`);
  }
  if (got.acquired) return got.lock;
  if (got.error) throw new InstallError(`could not take the install lock: ${got.error.message}`);
  const who = got.owner && !got.owner.incomplete ? ` (pid ${got.owner.pid} on ${got.owner.host}, since ${got.owner.startedAt})` : '';
  throw new InstallError(`another install is running in ${home}${who}. Wait for it to finish, then run this again.`);
}

// The default lock directory is a stranger inside the owner's home. `willCreate` (called before the lock is taken) lists
// the directories that do not exist yet, deepest first; `prune` takes them away again once no lock is left in them. rmdir
// only removes an empty directory, so another install's lock (or anything else) keeps it and everything above it.
function willCreate(home) {
  const out = [];
  for (let dir = I.installLockDir(home); !fs.existsSync(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}
function prune(dirs) {
  for (const dir of dirs) {
    try { fs.rmdirSync(dir); } catch { return; }
  }
}

// ---- --expect-installed ------------------------------------------------------------------------------------------

// `pipeline update --scheduled` decides to install onto a clean install of one commit, then downloads for minutes. This is its re-check, made with the
// install lock held and before anything is written (a check outside the lock leaves a window). Ported from #67, with the same identity rules as
// pipeline/commands/update.mjs: only a complete install of exactly `sha`, built from a clean checkout and with nothing modified, missing or added, matches.
// null when it still matches; otherwise { installed: <sha|null>, reason }.
function installMismatch(home, sha) {
  const id = installedIdentity(home);
  if (!id) return { installed: null, reason: 'nothing is installed there any more' };
  const unclean = !id.complete || id.sourceDirty || id.modified.length > 0 || id.missing.length > 0 || (id.extra?.length ?? 0) > 0 || (id.scanError?.length ?? 0) > 0;
  if (id.sourceSha !== sha) return { installed: id.sourceSha, reason: `the installed commit is ${id.sourceSha ? id.sourceSha.slice(0, 7) : 'unknown'}, not the ${sha.slice(0, 7)} the update was planned for` };
  if (unclean) return { installed: id.sourceSha, reason: `the installed copy ${id.stamp} was modified or is incomplete since the update was planned` };
  return null;
}

// ---- admission ---------------------------------------------------------------------------------------------------

// --require-no-live-reviews only ever targets the account's own claude-home (<accountHome()>/.claude, real paths compared): it is the unattended
// path, and a home elsewhere has no review leases to protect. accountHome() is the passwd home, never $HOME.
function accountClaudeHome(env) {
  const base = testSeam('PIPELINE_INSTALL_ACCOUNT_HOME', env) || accountHome();
  return path.join(base, '.claude');
}

const DEFAULT_DEADLINE_MS = 120_000;
const ADMISSION_WAIT_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What the exit-3 answer says. Always JSON on stdout (the updater parses it), one plain line on stderr.
function deferred(reason, live, extra = {}) {
  const body = { ok: false, deferred: true, reason, live, ...extra };
  const what = live.length > 0 ? live.slice(0, 3).map((e) => `${e.kind}${e.repo ? ` ${e.repo}` : ''}${e.pr ? ` #${e.pr}` : ''}${e.worktree ? ` (${e.worktree})` : ''}`).join('; ') : reason;
  process.stderr.write(`install.mjs: deferred (${reason}): ${what}${live.length > 3 ? ` and ${live.length - 3} more` : ''}. Nothing was changed.\n`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return 3;
}

// ---- main --------------------------------------------------------------------------------------------------

async function main(argv, env) {
  const startedAt = Date.now();
  const { opts, help, error } = I.parseArgs(argv);
  if (help) { process.stdout.write(`${I.usageText()}\n`); return 0; }
  if (error) { process.stderr.write(`install.mjs: ${error}\n\n${I.usageText()}\n`); return 2; }

  if (env.PIPELINE_ADMIN !== '1' && !opts.check) {
    if (env.CLAUDECODE === '1') {
      process.stderr.write('install.mjs refuses to run inside a Claude Code session (CLAUDECODE=1): run this in your own terminal, or start Claude with PIPELINE_ADMIN=1.\n');
      return 2;
    }
    if (hasClaudeCodeAncestor()) {
      process.stderr.write('install.mjs refuses to run inside a Claude Code session (a Claude Code process is an ancestor of this one, whatever CLAUDECODE says): close Claude Code or retry, run this in your own terminal, or start Claude with PIPELINE_ADMIN=1.\n');
      return 2;
    }
  }

  const home = path.resolve(expandHome(opts.claudeHome || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')));
  const source = path.resolve(expandHome(opts.source || path.dirname(fileURLToPath(import.meta.url))));
  const ctx = { opts, home, source, env };
  if (opts.requireNoLiveReviews) {
    const account = accountClaudeHome(env);
    if (!samePath(canonicalPath(home), canonicalPath(account))) {
      process.stderr.write(`install.mjs: --require-no-live-reviews only installs into the account's own claude-home (${account}); ${home} is not it. Nothing was changed.\n`);
      return 2;
    }
  }
  const deadlineAt = startedAt + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  let lock = null;
  let admission = null;
  let created = [];
  try {
    if (!opts.check) {
      created = env.PIPELINE_LOCK_DIR ? [] : willCreate(home);
      lock = takeWriteLock(home, env);
    }
    if (opts.expectInstalled) {
      const mismatch = installMismatch(home, opts.expectInstalled);
      if (mismatch) {
        process.stderr.write(`install.mjs: expect-installed-mismatch: ${mismatch.reason}. Nothing was changed.\n`);
        process.stdout.write(`${JSON.stringify({ ok: false, error: 'expect-installed-mismatch', installed: mismatch.installed, expected: opts.expectInstalled, message: mismatch.reason }, null, 2)}\n`);
        return 1;
      }
    }
    if (opts.requireNoLiveReviews) {
      // Lock order: install lock (held) -> admission -> scan. Admission is taken by THIS process and released only in the finally below, so a killed
      // parent (the scheduled `pipeline update`) cannot release it: no review is admitted until the swap and the verification are over.
      try {
        admission = await acquireAdmission({ env, waitMs: Math.max(0, Math.min(ADMISSION_WAIT_MS, deadlineAt - Date.now())) });
      } catch (err) {
        if (err?.code === 'update-in-progress') return deferred('admission-busy', [], { message: err.message });
        throw err;
      }
      const delay = Number(testSeam('PIPELINE_INSTALL_SCAN_DELAY_MS', env));
      if (Number.isFinite(delay) && delay > 0) await sleep(delay);
      let live;
      try {
        await sweepDeadLeases({ env });
        live = scanLiveWork({ env, deadlineAt });
        if (Date.now() > deadlineAt) throw new ScanDeadline();
      } catch (err) {
        if (err instanceof ScanDeadline) return deferred('deadline', [], { message: err.message, deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS });
        throw err;
      }
      if (live.length > 0) return deferred('live', live);
    }
    const report = opts.check ? doCheck(ctx) : opts.uninstall ? doUninstall(ctx) : doInstall(ctx);
    if (opts.requireNoLiveReviews && report.ok) {
      // The installer's own verification runs while admission is still held.
      const verify = doCheck(ctx);
      report.verify = { ok: verify.ok, drift: verify.drift };
      if (!verify.ok) { report.ok = false; report.error = 'verify-failed'; }
    }
    process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (err) {
    const exitCode = err instanceof InstallError ? err.exitCode : 1;
    const message = err instanceof InstallError ? err.message : `unexpected error: ${err?.stack ?? err}`;
    process.stderr.write(`install.mjs: ${message}\n`);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    return exitCode;
  } finally {
    if (admission) {
      try { releaseAdmission(admission); } catch { /* a stuck lock is reclaimed once this process is gone */ }
    }
    if (lock) {
      try { release(lock); } catch { /* a stuck lock is reclaimed once this process is gone */ }
      prune(created);
    }
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
