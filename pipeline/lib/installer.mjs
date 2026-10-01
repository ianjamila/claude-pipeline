// Why: the planning and merging half of the installer (install.mjs does the disk work). What ends up in the
// owner's ~/.claude/settings.json is decided here by pure functions, so it is testable on any OS: which hook
// handlers are ours (by their /pipeline/hooks/ path), how to merge them in without touching any other key,
// what the manifest looks like, and what counts as drift. Nothing here prints or exits.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toPosix } from './paths.mjs';

export const SKILLS = ['ship', 'verify', 'pipeline-setup'];
export const AGENTS = ['implementer', 'verifier', 'judge', 'arbiter'];
export const EXCLUDED_NAMES = new Set(['node_modules', '.DS_Store', 'test']);
export const MANIFEST_REL = 'pipeline/INSTALLED.json';
export const GUARD_FILES_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*';
export const HOOK_TIMEOUT_S = 15;
export const TILDE_ALLOW_ENTRY = 'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)';
export const SUBAGENT_NOTE = 'Pinned agent models (judge=opus, arbiter=fable) still win over this env var — verified on Claude Code 2.1.285; unpinned subagents use it.';
const MODEL_VAR = 'CLAUDE_CODE_SUBAGENT_MODEL';
const VERSION_TIMEOUT_MS = 10000;
const SAFE_ROOTS = new Set(['skills', 'agents', 'pipeline']);

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------------
// Arguments

const USAGE = `usage: node install.mjs [--claude-home DIR] [--source DIR] [--check] [--uninstall] [--skip-file-guard] [--force] [--json]

  --claude-home DIR   where to install (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --source DIR        the claude-pipeline checkout to install from (default: the directory holding install.mjs)
  --check             report drift between the source, the install and settings.json; exit 1 if any; never writes
  --uninstall         remove what was installed (files in the manifest, our hook entries, our allow entries)
  --skip-file-guard   do not install the file-guard hook (guard-git is always installed)
  --force             overwrite a same-named skill/agent/pipeline dir this installer did not install (kept in backups/)
  --json              machine-readable report on stdout`;
export const usageText = () => USAGE;

export function parseArgs(argv) {
  const opts = { claudeHome: null, source: null, check: false, uninstall: false, skipFileGuard: false, force: false, json: false };
  const valued = { '--claude-home': 'claudeHome', '--source': 'source' };
  const flags = { '--check': 'check', '--uninstall': 'uninstall', '--skip-file-guard': 'skipFileGuard', '--force': 'force', '--json': 'json' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { opts, help: true };
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name in valued) {
      let value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) return { opts, error: `${name} needs a value` };
      opts[valued[name]] = value;
    } else if (name in flags && eq < 0) {
      opts[flags[name]] = true;
    } else {
      return { opts, error: `unknown argument: ${arg}` };
    }
  }
  if (opts.check && opts.uninstall) return { opts, error: '--check and --uninstall cannot be combined' };
  return { opts };
}

// ---------------------------------------------------------------------------------------------------------
// Files

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Relative POSIX paths of the regular files under root, skipping excluded names at any depth. Symlinked
// directories are not followed; a symlink to a file counts as that file.
export function walkFiles(root, { exclude = EXCLUDED_NAMES } = {}) {
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { isFile = fs.statSync(childAbs).isFile(); } catch { isFile = false; }
        isDir = false;
      }
      if (isDir) visit(childAbs, childRel);
      else if (isFile) out.push(childRel);
    }
  };
  visit(root, '');
  return out.sort(byCodeUnit);
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const fromRel = (base, rel) => path.join(base, ...rel.split('/'));

// What install would copy. A unit is the thing replaced as a whole: the pipeline dir, one skill dir or one
// agent file. Order matters: pipeline first, so the new manifest lands before skills and agents change.
// Reads the source tree and hashes it; problems lists everything missing from an incomplete source.
export function buildPlan(source) {
  const problems = [];
  const warnings = [];
  const units = [];
  const files = new Map();
  let version = null;

  try { version = fs.readFileSync(path.join(source, 'VERSION'), 'utf8').trim(); } catch { /* reported below */ }
  if (!version) problems.push('VERSION is missing or empty');

  const addUnit = (kind, name, rel, entries) => {
    const unit = { kind, name, rel, files: [] };
    for (const { rel: fileRel, abs } of entries) {
      const entry = { rel: fileRel, abs, sha256: sha256File(abs) };
      unit.files.push(entry);
      files.set(fileRel, entry);
    }
    units.push(unit);
  };

  const pipelineDir = path.join(source, 'pipeline');
  if (!isDirectory(pipelineDir)) {
    problems.push('pipeline/ is missing');
  } else {
    const entries = walkFiles(pipelineDir)
      .filter((r) => r !== 'INSTALLED.json')
      .map((r) => ({ rel: `pipeline/${r}`, abs: path.join(pipelineDir, ...r.split('/')) }));
    for (const hook of ['guard-git.mjs', 'guard-files.mjs']) {
      if (!entries.some((e) => e.rel === `pipeline/hooks/${hook}`)) problems.push(`pipeline/hooks/${hook} is missing`);
    }
    if (isFile(path.join(source, 'VERSION'))) {
      const at = entries.findIndex((e) => e.rel === 'pipeline/VERSION');
      const versionEntry = { rel: 'pipeline/VERSION', abs: path.join(source, 'VERSION') };
      if (at >= 0) entries[at] = versionEntry; else entries.push(versionEntry);
    }
    entries.sort((a, b) => byCodeUnit(a.rel, b.rel));
    addUnit('pipeline', 'pipeline', 'pipeline', entries);
  }

  for (const name of AGENTS) {
    const abs = path.join(source, 'agents', `${name}.md`);
    if (!isFile(abs)) warnings.push(`the source has no agents/${name}.md; it will not be installed`);
    else addUnit('agent', name, `agents/${name}.md`, [{ rel: `agents/${name}.md`, abs }]);
  }

  for (const name of SKILLS) {
    const dir = path.join(source, 'skills', name);
    if (!isDirectory(dir)) { warnings.push(`the source has no skills/${name}/; it will not be installed`); continue; }
    const entries = walkFiles(dir).map((r) => ({ rel: `skills/${name}/${r}`, abs: path.join(dir, ...r.split('/')) }));
    if (!entries.some((e) => e.rel === `skills/${name}/SKILL.md`)) problems.push(`skills/${name}/SKILL.md is missing`);
    addUnit('skill', name, `skills/${name}`, entries);
  }

  if (!units.some((u) => u.kind !== 'pipeline')) problems.push('the source has no skills or agents');
  return { source, version, units, files, problems, warnings };
}

export function unitTarget(home, unit) {
  return fromRel(home, unit.rel);
}

// Files currently on disk for a unit: Map of home-relative path -> sha256 (empty when the target is absent).
export function scanUnitDisk(home, unit) {
  const out = new Map();
  const target = unitTarget(home, unit);
  if (unit.kind === 'agent') {
    if (isFile(target)) out.set(unit.rel, sha256File(target));
    return out;
  }
  if (!isDirectory(target)) return out;
  for (const r of walkFiles(target)) {
    if (unit.kind === 'pipeline' && r === 'INSTALLED.json') continue;
    out.set(`${unit.rel}/${r}`, sha256File(path.join(target, ...r.split('/'))));
  }
  return out;
}

// 'missing' (nothing at the target), 'same' (exactly our files, byte for byte) or 'different'.
export function unitState(home, unit) {
  const target = unitTarget(home, unit);
  if (!lexists(target)) return 'missing';
  let st;
  try { st = fs.lstatSync(target); } catch { return 'different'; }
  if (st.isSymbolicLink()) return 'different';
  const disk = scanUnitDisk(home, unit);
  if (disk.size !== unit.files.length) return 'different';
  for (const f of unit.files) if (disk.get(f.rel) !== f.sha256) return 'different';
  return 'same';
}

// ---------------------------------------------------------------------------------------------------------
// Manifest

// A manifest key is a relative POSIX path under skills/, agents/ or pipeline/. Anything else (absolute, "..",
// backslashes, empty segments) is ignored so a corrupt or planted manifest can never make us touch files
// outside what we install.
export function safeManifestKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\\') || key.startsWith('/') || /^[A-Za-z]:/.test(key)) return false;
  const parts = key.split('/');
  if (parts.length < 2 || !SAFE_ROOTS.has(parts[0])) return false;
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

export function buildManifest({ plan, sourceSha, skipFileGuard, now = new Date() }) {
  const files = {};
  for (const rel of [...plan.files.keys()].sort(byCodeUnit)) files[rel] = plan.files.get(rel).sha256;
  return {
    version: plan.version,
    sourceSha: sourceSha ?? null,
    installedAt: now.toISOString(),
    files,
    hooks: { guardGit: true, guardFiles: !skipFileGuard },
  };
}

// { manifest, warnings }: manifest is null when absent or unusable (warnings say why).
export function readManifest(home) {
  const file = fromRel(home, MANIFEST_REL);
  const warnings = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`cannot read ${MANIFEST_REL}: ${err.message}`);
    return { manifest: null, warnings };
  }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch (err) {
    warnings.push(`${MANIFEST_REL} is not valid JSON (${err.message}); treating nothing as installed`);
    return { manifest: null, warnings };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) {
    warnings.push(`${MANIFEST_REL} has no "files" object; treating nothing as installed`);
    return { manifest: null, warnings };
  }
  const files = {};
  for (const [key, value] of Object.entries(parsed.files)) {
    if (key === MANIFEST_REL) continue;
    if (!safeManifestKey(key)) { warnings.push(`ignoring unsafe manifest entry: ${JSON.stringify(key)}`); continue; }
    files[key] = value;
  }
  return { manifest: { ...parsed, files }, warnings };
}

// Whether a skill dir / agent file was installed by us, per the (sanitised) manifest.
export function manifestOwns(manifest, unit) {
  if (!manifest) return false;
  if (unit.kind === 'pipeline') return true; // the manifest itself lives in pipeline/
  const keys = Object.keys(manifest.files);
  return unit.kind === 'agent' ? keys.includes(unit.rel) : keys.some((k) => k.startsWith(`${unit.rel}/`));
}

// Units that exist, hold something other than our exact files, and are not ours: install must refuse them.
export function findConflicts({ home, plan, manifest, states }) {
  const conflicts = [];
  for (const unit of plan.units) {
    const state = states ? states.get(unit.rel) : unitState(home, unit);
    if (state === 'missing' || state === 'same') continue;
    if (manifestOwns(manifest, unit)) continue;
    if (unit.kind === 'pipeline' && isEmptyDir(unitTarget(home, unit))) continue;
    conflicts.push(unit.rel);
  }
  return conflicts;
}

function isEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------
// settings.json

export class SettingsShapeError extends Error {}

export function joinNative(home, ...parts) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(home);
  return (windows ? path.win32 : path.posix).join(home, ...parts);
}

const OURS = /\/\.claude\/pipeline\/hooks\/|\/pipeline\/hooks\/guard-/i;

// A hook handler is ours when its command or any arg points into the pipeline hooks dir (either slash
// direction), which also catches handlers written by earlier installs in the string command form.
export function isOurHandler(handler) {
  if (!isPlainObject(handler)) return false;
  const strings = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
  return strings.some((s) => typeof s === 'string' && OURS.test(toPosix(s)));
}

export function ourAllowEntries(home) {
  return [`Bash(node ${toPosix(home).replace(/\/+$/, '')}/pipeline/bin/pipeline.mjs:*)`, TILDE_ALLOW_ENTRY];
}

const handlerFor = (home, name) => ({
  type: 'command',
  command: 'node',
  args: [joinNative(home, 'pipeline', 'hooks', `${name}.mjs`)],
  timeout: HOOK_TIMEOUT_S,
});

export function ourHookGroups(home, { skipFileGuard = false } = {}) {
  const groups = [{ matcher: 'Bash', hooks: [handlerFor(home, 'guard-git')] }];
  if (!skipFileGuard) groups.push({ matcher: GUARD_FILES_MATCHER, hooks: [handlerFor(home, 'guard-files')] });
  return groups;
}

function assertShape(settings) {
  if (!isPlainObject(settings)) throw new SettingsShapeError('settings.json must contain a JSON object');
  if ('hooks' in settings && !isPlainObject(settings.hooks)) throw new SettingsShapeError('settings.json: "hooks" is not an object');
  if (isPlainObject(settings.hooks) && 'PreToolUse' in settings.hooks && !Array.isArray(settings.hooks.PreToolUse)) {
    throw new SettingsShapeError('settings.json: "hooks.PreToolUse" is not an array');
  }
  if ('permissions' in settings && !isPlainObject(settings.permissions)) throw new SettingsShapeError('settings.json: "permissions" is not an object');
  if (isPlainObject(settings.permissions) && 'allow' in settings.permissions && !Array.isArray(settings.permissions.allow)) {
    throw new SettingsShapeError('settings.json: "permissions.allow" is not an array');
  }
}

// Removes our handlers from hooks.PreToolUse in place; drops groups that this leaves empty. Returns the count.
function stripOurHandlers(settings) {
  const groups = settings.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return 0;
  let removed = 0;
  settings.hooks.PreToolUse = groups.filter((group) => {
    if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) return true;
    const kept = group.hooks.filter((h) => !isOurHandler(h));
    removed += group.hooks.length - kept.length;
    if (kept.length === group.hooks.length) return true;
    group.hooks = kept;
    return kept.length > 0;
  });
  return removed;
}

// Pure: returns a new settings object with our hook groups appended (guard-files last) and our allow entries
// added once. Any earlier handlers of ours are replaced; every other key, hook and entry is left as it was.
export function mergeSettings(settings, { home, skipFileGuard = false }) {
  assertShape(settings);
  const out = structuredClone(settings);
  stripOurHandlers(out);
  out.hooks ??= {};
  out.hooks.PreToolUse ??= [];
  out.hooks.PreToolUse.push(...ourHookGroups(home, { skipFileGuard }));
  out.permissions ??= {};
  out.permissions.allow ??= [];
  for (const entry of ourAllowEntries(home)) if (!out.permissions.allow.includes(entry)) out.permissions.allow.push(entry);
  return out;
}

// Pure inverse for --uninstall. A container (PreToolUse, hooks, allow, permissions) that our removal leaves
// empty is dropped, so installing into a settings file that had none of them and uninstalling round-trips.
export function removeOurSettings(settings, { home }) {
  assertShape(settings);
  const out = structuredClone(settings);
  if (stripOurHandlers(out) > 0 && out.hooks.PreToolUse.length === 0) {
    delete out.hooks.PreToolUse;
    if (Object.keys(out.hooks).length === 0) delete out.hooks;
  }
  const allow = out.permissions?.allow;
  if (Array.isArray(allow)) {
    const ours = new Set(ourAllowEntries(home));
    const kept = allow.filter((e) => !ours.has(e));
    if (kept.length !== allow.length) {
      out.permissions.allow = kept;
      if (kept.length === 0) {
        delete out.permissions.allow;
        if (Object.keys(out.permissions).length === 0) delete out.permissions;
      }
    }
  }
  return out;
}

const scriptOf = (handler) => {
  const text = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].filter((s) => typeof s === 'string').map(toPosix).join(' ');
  if (/\/guard-git\.mjs/.test(text)) return 'guard-git';
  if (/\/guard-files\.mjs/.test(text)) return 'guard-files';
  return null;
};

// Our handlers in hooks.PreToolUse, grouped by script, each flagged exact when it equals what install writes.
export function inspectHooks(settings, home) {
  const out = { 'guard-git': [], 'guard-files': [], unknown: [] };
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return out;
  const matcherFor = { 'guard-git': 'Bash', 'guard-files': GUARD_FILES_MATCHER };
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (!isOurHandler(handler)) continue;
      const script = scriptOf(handler);
      if (!script) { out.unknown.push({ matcher: group.matcher, handler }); continue; }
      out[script].push({
        matcher: group.matcher,
        handler,
        exact: group.matcher === matcherFor[script] && isDeepStrictEqual(handler, handlerFor(home, script)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Drift (--check)

// Everything install would change, as { kind, path?, message } items. Empty means nothing to do.
// settings is the parsed settings.json (null when the file is missing); settingsProblem is set when it is unusable.
export function computeDrift({ home, plan, manifest, settings, settingsProblem, skipFileGuard }) {
  const drift = [];
  const add = (kind, p, message) => drift.push({ kind, path: p, message });

  if (!manifest) add('not-installed', MANIFEST_REL, `${MANIFEST_REL} is missing: claude-pipeline is not installed in ${home}`);
  const states = new Map();
  for (const unit of plan.units) states.set(unit.rel, unitState(home, unit));

  for (const rel of findConflicts({ home, plan, manifest, states })) {
    add('conflict', rel, `conflict: ${rel} exists and was not installed by claude-pipeline (install refuses without --force)`);
  }

  const conflicted = new Set(findConflicts({ home, plan, manifest, states }));
  for (const unit of plan.units) {
    const state = states.get(unit.rel);
    if (state === 'same' || conflicted.has(unit.rel)) continue;
    if (state === 'missing') {
      add('missing', unit.rel, `missing: ${unit.rel}${unit.kind === 'agent' ? '' : `/ (${unit.files.length} file${unit.files.length === 1 ? "" : "s"})`}`);
      continue;
    }
    const disk = scanUnitDisk(home, unit);
    for (const f of unit.files) {
      const onDisk = disk.get(f.rel);
      if (onDisk === undefined) add('missing', f.rel, `missing: ${f.rel}`);
      else if (onDisk !== f.sha256) {
        if (manifest?.files[f.rel] !== undefined && manifest.files[f.rel] !== onDisk) add('modified', f.rel, `modified: ${f.rel} (edited since install)`);
        else add('outdated', f.rel, `outdated: ${f.rel} (the source has changed since install)`);
      }
    }
    const planned = new Set(unit.files.map((f) => f.rel));
    for (const rel of disk.keys()) {
      if (planned.has(rel)) continue;
      if (manifest?.files[rel] !== undefined) add('stale', rel, `stale: ${rel} (no longer in the source; reinstall removes it)`);
      else add('extra', rel, `extra: ${rel} (not part of the install; reinstall removes it)`);
    }
  }
  // Manifest entries whose whole unit has left the source (a skill dir or agent that was dropped).
  const plannedUnits = new Set(plan.units.map((u) => u.rel));
  for (const rel of Object.keys(manifest?.files ?? {})) {
    if (plan.files.has(rel)) continue;
    const parts = rel.split('/');
    const unitRel = parts[0] === 'skills' ? `skills/${parts[1]}` : parts[0] === 'agents' ? rel : 'pipeline';
    if (plannedUnits.has(unitRel) || !lexists(fromRel(home, rel))) continue;
    add('stale', rel, `stale: ${rel} (no longer in the source; reinstall removes it)`);
  }

  // settings.json
  if (settingsProblem) {
    add('settings', 'settings.json', `settings.json: ${settingsProblem}`);
    return drift;
  }
  const expectGuardFiles = skipFileGuard ? false : (manifest?.hooks?.guardFiles ?? true);
  if (settings === null) {
    add('settings', 'settings.json', 'settings.json is missing: no hooks or allow entries are installed');
    return drift;
  }
  const found = inspectHooks(settings, home);
  const before = drift.length;
  const hookCheck = (script, expected) => {
    const list = found[script];
    if (expected && list.length === 0) add('hook-missing', script, `hook missing: ${script} is not in hooks.PreToolUse`);
    else if (expected && list.length > 1) add('hook-duplicated', script, `hook duplicated: ${script} appears ${list.length} times in hooks.PreToolUse`);
    else if (expected && !list[0].exact) add('hook-differs', script, `hook differs: the ${script} entry is not what install writes (path, matcher or timeout)`);
    else if (!expected && list.length > 0) add('hook-unexpected', script, `unexpected hook: ${script} is installed but this install omits it (--skip-file-guard)`);
  };
  hookCheck('guard-git', true);
  hookCheck('guard-files', expectGuardFiles);
  for (const u of found.unknown) add('hook-unknown', null, `unrecognised hook entry in the pipeline hooks dir: ${JSON.stringify(u.handler)}`);

  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  for (const entry of ourAllowEntries(home)) {
    if (!allow.includes(entry)) add('allow-missing', entry, `allow entry missing: ${entry}`);
  }

  if (drift.length === before) {
    let merged = null;
    try { merged = mergeSettings(settings, { home, skipFileGuard: !expectGuardFiles }); } catch { /* shape problems surface at install */ }
    if (merged && !isDeepStrictEqual(merged, settings)) {
      add('hook-order', 'settings.json', 'hook order: our hook entries are not the last PreToolUse entries (guard-files must be last); reinstall fixes it');
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------------------------------------
// Atomic-ish renames

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
export const sleepMs = (ms) => Atomics.wait(sleepBuffer, 0, 0, ms);

// Windows holds files open (antivirus, indexers) and then rename fails with EPERM/EBUSY for a moment, so
// retry there. On other platforms those codes are real errors.
export function renameWithRetry(from, to, { rename = fs.renameSync, platform = process.platform, sleep = sleepMs, attempts = 20, delayMs = 50 } = {}) {
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (err) {
      const retryable = platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EBUSY');
      if (!retryable || i >= attempts) throw err;
      sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Diagnostics

export function shellRcPaths(home, platform = process.platform) {
  const posixRc = ['.zshrc', '.bashrc', '.zprofile', '.profile', '.bash_profile'].map((f) => path.join(home, f));
  if (platform !== 'win32') return posixRc;
  const docs = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')];
  const ps = [];
  for (const d of docs) {
    for (const dir of ['PowerShell', 'WindowsPowerShell']) {
      for (const f of ['Microsoft.PowerShell_profile.ps1', 'profile.ps1']) ps.push(path.join(d, dir, f));
    }
  }
  return [...posixRc, ...ps];
}

export function scanShellFiles(files, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const hits = [];
  for (const file of files) {
    let text;
    try { text = readFile(file); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes(MODEL_VAR) || /^\s*#/.test(line)) return;
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return hits;
}

function probeVersion(runFn, cmd) {
  try {
    const r = runFn(cmd, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    if (r.timedOut) return `timed out after ${VERSION_TIMEOUT_MS / 1000}s`;
    if (r.code !== 0) return /ENOENT|not found|not recognized/i.test(r.stderr ?? '') || r.code === 127 ? 'not found' : `failed (exit ${r.code})`;
    return (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'unknown';
  } catch {
    return 'not found';
  }
}

// Never throws. runFn null skips the version probes (versions: null).
export function collectDiagnostics({ settings, env = process.env, home, platform = process.platform, runFn }) {
  const settingsValue = settings?.env?.[MODEL_VAR];
  return {
    subagentModel: {
      settingsEnv: typeof settingsValue === 'string' ? settingsValue : null,
      processEnv: env[MODEL_VAR] ? env[MODEL_VAR] : null,
      shellFiles: scanShellFiles(shellRcPaths(home, platform)),
    },
    note: SUBAGENT_NOTE,
    versions: runFn ? Object.fromEntries(['claude', 'codex', 'gh'].map((cmd) => [cmd, probeVersion(runFn, cmd)])) : null,
  };
}
