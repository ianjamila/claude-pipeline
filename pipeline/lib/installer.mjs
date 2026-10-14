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
export const EXCLUDED_NAMES = new Set(['node_modules', '.DS_Store']);
// Skipped only directly under the walked root (pipeline/, skills/<name>/): a nested reference/test/ is content.
export const EXCLUDED_TOP_LEVEL = new Set(['test']);
export const MANIFEST_REL = 'pipeline/INSTALLED.json';
export const GUARD_GIT_MATCHER = 'Bash|PowerShell|Monitor|mcp__.*';
export const GUARD_FILES_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*';
export const HOOK_TIMEOUT_S = 15;
export const SESSION_HOOK_TIMEOUT_S = 10;
// The events whose hooks this installer manages: guard hooks on PreToolUse, the version-status hook on SessionStart.
const HOOK_EVENTS = ['PreToolUse', 'SessionStart'];
export const STAGING_REL = 'backups/.staging';
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
                          [--expect-installed SHA]

  --claude-home DIR   where to install (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --source DIR        the claude-pipeline checkout to install from (default: the directory holding install.mjs)
  --check             report drift between the source, the install and settings.json; exit 1 if any; never writes
  --uninstall         remove what was installed (files in the manifest, our hook entries, our allow entries)
  --skip-file-guard   do not install the file-guard hook (guard-git is always installed)
  --force             overwrite a same-named skill/agent/pipeline dir this installer did not install (kept in backups/)
  --expect-installed SHA  install only if the claude-home still holds a clean install of commit SHA (checked under the write lock,
                      before anything is written); otherwise exit 3 with error install-changed. The unattended update passes it.
  --json              machine-readable report on stdout`;
export const usageText = () => USAGE;

export function parseArgs(argv) {
  const opts = { claudeHome: null, source: null, check: false, uninstall: false, skipFileGuard: false, force: false, json: false };
  const valued = { '--claude-home': 'claudeHome', '--source': 'source', '--expect-installed': 'expectInstalled' };
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
  if (opts.expectInstalled && (opts.check || opts.uninstall)) return { opts, error: '--expect-installed only applies to an install' };
  return { opts };
}

// ---------------------------------------------------------------------------------------------------------
// Files

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Relative POSIX paths of the regular files under root, skipping excluded names at any depth and topLevel
// names only directly under root. Symlinked directories are not followed; a symlink to a file counts as that file.
// A directory that cannot be listed is skipped, but reported to `onError(relDir, error)` when given, so a caller that
// must not read "nothing found" as "nothing there" can tell.
export function walkFiles(root, { exclude = EXCLUDED_NAMES, topLevel = EXCLUDED_TOP_LEVEL, onError = null } = {}) {
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) { if (onError) onError(rel, err); return; }
    for (const e of entries) {
      if (exclude.has(e.name) || (rel === '' && topLevel.has(e.name))) continue;
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
export const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
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
    for (const hook of ['guard-git.mjs', 'guard-files.mjs', 'session-version.mjs']) {
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

// The installer-owned units, by descriptor only (no source needed): the places an install writes under a claude-home.
export const installedUnits = () => [
  { kind: 'pipeline', name: 'pipeline', rel: 'pipeline' },
  ...AGENTS.map((name) => ({ kind: 'agent', name, rel: `agents/${name}.md` })),
  ...SKILLS.map((name) => ({ kind: 'skill', name, rel: `skills/${name}` })),
];

// Home-relative paths of files sitting in an installer-owned unit that the manifest does not list (something added
// after the install). Same walker and exclusions as install, so what install ignores is ignored here too. Paths are
// only listed, never read: one unreadable file must not hide the others. Returns { extra, unreadable }; `unreadable`
// = home-relative directories that could not be listed (what is in them is unknown).
export function scanExtraInstalledFiles(home, manifest) {
  const extra = [];
  const unreadable = [];
  for (const unit of installedUnits()) {
    const target = unitTarget(home, unit);
    if (unit.kind === 'agent') {
      if (isFile(target) && !Object.hasOwn(manifest.files, unit.rel)) extra.push(unit.rel);
      continue;
    }
    if (!isDirectory(target)) continue;
    const onError = (relDir) => unreadable.push(relDir ? `${unit.rel}/${relDir}` : unit.rel);
    for (const r of walkFiles(target, { onError })) {
      if (unit.kind === 'pipeline' && r === 'INSTALLED.json') continue;
      const rel = `${unit.rel}/${r}`;
      if (!Object.hasOwn(manifest.files, rel)) extra.push(rel);
    }
  }
  return { extra: extra.sort(byCodeUnit), unreadable: unreadable.sort(byCodeUnit) };
}

export function extraInstalledFiles(home, manifest) {
  return scanExtraInstalledFiles(home, manifest).extra;
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

// Home-relative paths of files in an installed unit that the user changed since install: a file whose hash
// differs from the manifest, or one the manifest does not list. A symlinked target counts as edited. Empty
// when the unit is absent or there is no manifest (nothing says what we installed).
export function userEditedFiles(home, unit, manifest) {
  if (!manifest) return [];
  const target = unitTarget(home, unit);
  let st;
  try { st = fs.lstatSync(target); } catch { return []; }
  if (st.isSymbolicLink()) return [unit.rel];
  const edited = [];
  for (const [rel, hash] of scanUnitDisk(home, unit)) if (manifest.files[rel] !== hash) edited.push(rel);
  return edited;
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

// `git ls-tree -r -z HEAD` output -> Map of path -> blob id (regular files and symlinks; submodule entries are skipped).
export function parseLsTree(text) {
  const blobs = new Map();
  for (const entry of text.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), id);
  }
  return blobs;
}

// Of the paths HEAD holds (source-root-relative, POSIX), the ones an install would copy, named as the plan names the
// source file: pipeline/** (minus INSTALLED.json, EXCLUDED_NAMES anywhere, EXCLUDED_TOP_LEVEL directly under pipeline/),
// agents/<name>.md for AGENTS, skills/<name>/** for SKILLS (same exclusions) and the root VERSION, which is what
// installs as pipeline/VERSION. Lets provenance notice a source file deleted from the working tree.
export function installableSourcePaths(headPaths) {
  const out = new Set();
  const keep = (parts) => parts.length > 0 && !EXCLUDED_TOP_LEVEL.has(parts[0]) && !parts.some((p) => EXCLUDED_NAMES.has(p));
  for (const p of headPaths) {
    const parts = p.split('/');
    if (p === 'VERSION' || p === 'pipeline/VERSION') out.add('VERSION');
    else if (parts[0] === 'pipeline' && parts.length > 1) {
      if (p !== 'pipeline/INSTALLED.json' && keep(parts.slice(1))) out.add(p);
    } else if (parts[0] === 'agents' && parts.length === 2) {
      if (AGENTS.some((n) => parts[1] === `${n}.md`)) out.add(p);
    } else if (parts[0] === 'skills' && parts.length > 2 && SKILLS.includes(parts[1])) {
      if (keep(parts.slice(2))) out.add(p);
    }
  }
  return out;
}

// Source-relative paths (POSIX) of planned files that are not exactly what HEAD holds: absent from HEAD, or a different
// blob. `hashes` is the blob id git computes for each path in the working tree (filters applied), in the same order.
export function pathsDifferingFromHead(paths, headBlobs, hashes) {
  return paths.filter((p, i) => headBlobs.get(p) !== hashes[i]);
}

// The real location of `p`: symlinks resolved on the deepest ancestor that exists, the not-yet-created rest appended.
// A claude-home reached through an alias (a symlinked ~/.claude, a second mount point) must name the same lock.
export function canonicalPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* not there yet: try the parent */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

// Where the write lock for `home` lives: inside the destination itself, so it is scoped to that home and never to
// whoever happens to run the installer.
export const installLockDir = (home) => path.join(canonicalPath(home), 'backups', '.locks');

// Name of the write lock for one claude-home: two installs into the same home exclude each other, installs into
// different homes do not. The canonical (symlink-resolved) path is case-folded where the filesystem is (Windows,
// macOS), then hashed so the name is a safe file name whatever the path holds.
export function installLockName(home) {
  const resolved = canonicalPath(home);
  return `installer-${createHash('sha256').update(foldCase(resolved)).digest('hex').slice(0, 16)}`;
}

// The same manifest, minus the one field that changes on every run.
export const manifestWithoutTime = ({ installedAt, ...rest }) => rest;

// complete: false is what the pipeline unit carries while the rest of the install is still being swapped in; the
// final rewrite says true. A manifest without the field (every install before it existed) counts as complete.
export const manifestComplete = (manifest) => manifest?.complete !== false;

export function buildManifest({ plan, sourceSha, skipFileGuard, complete = false, sourceDirty = false, now = new Date() }) {
  const files = {};
  for (const rel of [...plan.files.keys()].sort(byCodeUnit)) files[rel] = plan.files.get(rel).sha256;
  return {
    version: plan.version,
    sourceSha: sourceSha ?? null,
    ...(sourceDirty ? { sourceDirty: true } : {}),
    installedAt: now.toISOString(),
    complete: Boolean(complete),
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

const CLAUDE_HOOKS_DIR = '/.claude/pipeline/hooks/';
const foldCase = (s) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
const hooksDirOf = (home) => `${toPosix(home).replace(/\/+$/, '')}/pipeline/hooks/`;
// anchored: the directory must start a word, so /x/home/pipeline/hooks/ does not match inside /y/x/home/...
function pointsInto(text, dir, anchored) {
  const hay = foldCase(text);
  const needle = foldCase(dir);
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (!anchored || at === 0 || /[\s"'=]/.test(hay[at - 1])) return true;
  }
  return false;
}

// A hook handler is ours when its command or any arg points into the exact hooks dir this installer writes to
// (<claude-home>/pipeline/hooks/) or into the literal /.claude/pipeline/hooks/ (earlier installs, other machines
// sharing a synced settings file). Either slash direction. Any other pipeline/hooks/ path belongs to the user.
export function isOurHandler(handler, home) {
  if (!isPlainObject(handler)) return false;
  const homeDir = typeof home === 'string' && home !== '' ? hooksDirOf(home) : null;
  const strings = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
  return strings.some((s) => {
    if (typeof s !== 'string') return false;
    const posix = toPosix(s);
    return pointsInto(posix, CLAUDE_HOOKS_DIR, false) || (homeDir !== null && pointsInto(posix, homeDir, true));
  });
}

// The allow entries for our CLI. A home path with whitespace gets a second, quoted entry as well, because
// Claude Code matches the command text the shell sees and a quoted path is what the user's agent will type.
export function ourAllowEntries(home) {
  const bin = `${toPosix(home).replace(/\/+$/, '')}/pipeline/bin/pipeline.mjs`;
  const entries = [`Bash(node ${bin}:*)`];
  if (/\s/.test(bin)) entries.push(`Bash(node "${bin}":*)`);
  entries.push(TILDE_ALLOW_ENTRY);
  return entries;
}

// Why: Claude Code treats a hook that exits 1 (what `node <missing file>` does, e.g. while an install swaps the hooks
// dir in) as a NON-blocking error, so the tool call is allowed. Exit 2 blocks. The guards are therefore started through
// this loader: it imports the hook file (process.argv[1], the first argument after `-e`) and, if the import itself
// fails (file missing, a module that will not load), says so on stderr and exits 2. A hook that loads runs exactly as
// before: it reads stdin and writes its own JSON; the loader adds nothing to its output or exit code.
export const HOOK_LOADER = [
  "import { pathToFileURL } from 'node:url';",
  'try { await import(pathToFileURL(process.argv[1]).href); } catch (e) {',
  "process.stderr.write('claude-pipeline: hook could not be loaded (' + ((e && (e.code || e.message)) || e) + '); blocking this call\\n', () => process.exit(2));",
  '}',
].join(' ');

const handlerFor = (home, name) => ({
  type: 'command',
  command: 'node',
  args: ['--input-type=module', '-e', HOOK_LOADER, joinNative(home, 'pipeline', 'hooks', `${name}.mjs`)],
  timeout: HOOK_TIMEOUT_S,
});

// The status hook is deliberately NOT started through the fail-closed loader: a SessionStart failure must never block anything.
const sessionHandlerFor = (home) => ({
  type: 'command',
  command: 'node',
  args: [joinNative(home, 'pipeline', 'hooks', 'session-version.mjs')],
  timeout: SESSION_HOOK_TIMEOUT_S,
});

export function ourHookGroups(home, { skipFileGuard = false } = {}) {
  const groups = [{ matcher: GUARD_GIT_MATCHER, hooks: [handlerFor(home, 'guard-git')] }];
  if (!skipFileGuard) groups.push({ matcher: GUARD_FILES_MATCHER, hooks: [handlerFor(home, 'guard-files')] });
  return groups;
}

// Our own group (no matcher: every start source), appended after whatever the owner already has on SessionStart.
export const ourSessionStartGroups = (home) => [{ hooks: [sessionHandlerFor(home)] }];

function assertShape(settings) {
  if (!isPlainObject(settings)) throw new SettingsShapeError('settings.json must contain a JSON object');
  if ('hooks' in settings && !isPlainObject(settings.hooks)) throw new SettingsShapeError('settings.json: "hooks" is not an object');
  for (const event of HOOK_EVENTS) {
    if (isPlainObject(settings.hooks) && event in settings.hooks && !Array.isArray(settings.hooks[event])) {
      throw new SettingsShapeError(`settings.json: "hooks.${event}" is not an array`);
    }
  }
  if ('permissions' in settings && !isPlainObject(settings.permissions)) throw new SettingsShapeError('settings.json: "permissions" is not an object');
  if (isPlainObject(settings.permissions) && 'allow' in settings.permissions && !Array.isArray(settings.permissions.allow)) {
    throw new SettingsShapeError('settings.json: "permissions.allow" is not an array');
  }
}

// Removes our handlers from hooks.PreToolUse and hooks.SessionStart in place; drops groups that this leaves empty.
// Returns the count removed.
function stripOurHandlers(settings, home) {
  let removed = 0;
  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter((group) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) return true;
      const kept = group.hooks.filter((h) => !isOurHandler(h, home));
      removed += group.hooks.length - kept.length;
      if (kept.length === group.hooks.length) return true;
      group.hooks = kept;
      return kept.length > 0;
    });
  }
  return removed;
}

// Pure: returns a new settings object with our hook groups appended (guard-files last; the SessionStart status group
// after the owner's own) and our allow entries added once. Any earlier handlers of ours are replaced; every other key, hook and entry is left as it was.
export function mergeSettings(settings, { home, skipFileGuard = false }) {
  assertShape(settings);
  const out = structuredClone(settings);
  stripOurHandlers(out, home);
  out.hooks ??= {};
  out.hooks.PreToolUse ??= [];
  out.hooks.PreToolUse.push(...ourHookGroups(home, { skipFileGuard }));
  out.hooks.SessionStart ??= [];
  out.hooks.SessionStart.push(...ourSessionStartGroups(home));
  out.permissions ??= {};
  out.permissions.allow ??= [];
  for (const entry of ourAllowEntries(home)) if (!out.permissions.allow.includes(entry)) out.permissions.allow.push(entry);
  return out;
}

// Pure inverse for --uninstall. A container (PreToolUse, SessionStart, hooks, allow, permissions) that our removal
// leaves empty is dropped, so installing into a settings file that had none of them and uninstalling round-trips.
export function removeOurSettings(settings, { home }) {
  assertShape(settings);
  const out = structuredClone(settings);
  if (stripOurHandlers(out, home) > 0) {
    for (const event of HOOK_EVENTS) if (Array.isArray(out.hooks[event]) && out.hooks[event].length === 0) delete out.hooks[event];
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
  if (/\/session-version\.mjs/.test(text)) return 'session-version';
  return null;
};

// Our handlers, grouped by script, each flagged exact when it equals what install writes. The guards are read from
// hooks.PreToolUse, the status hook from hooks.SessionStart; one of ours under the wrong event is `unknown`.
export function inspectHooks(settings, home) {
  const out = { 'guard-git': [], 'guard-files': [], 'session-version': [], unknown: [] };
  const expected = {
    'guard-git': { event: 'PreToolUse', matcher: GUARD_GIT_MATCHER, handler: handlerFor(home, 'guard-git') },
    'guard-files': { event: 'PreToolUse', matcher: GUARD_FILES_MATCHER, handler: handlerFor(home, 'guard-files') },
    'session-version': { event: 'SessionStart', matcher: undefined, handler: sessionHandlerFor(home) },
  };
  for (const event of HOOK_EVENTS) {
    const groups = settings?.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (!isOurHandler(handler, home)) continue;
        const script = scriptOf(handler);
        if (!script || expected[script].event !== event) { out.unknown.push({ matcher: group.matcher, handler }); continue; }
        out[script].push({
          matcher: group.matcher,
          handler,
          exact: group.matcher === expected[script].matcher && isDeepStrictEqual(handler, expected[script].handler),
        });
      }
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
  else if (!manifestComplete(manifest)) add('incomplete', MANIFEST_REL, 'incomplete: a previous install did not finish; re-run the installer');
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
  const hookCheck = (script, expected, event = 'PreToolUse') => {
    const list = found[script];
    if (expected && list.length === 0) add('hook-missing', script, `hook missing: ${script} is not in hooks.${event}`);
    else if (expected && list.length > 1) add('hook-duplicated', script, `hook duplicated: ${script} appears ${list.length} times in hooks.${event}`);
    else if (expected && !list[0].exact) add('hook-differs', script, `hook differs: the ${script} entry is not what install writes (path, matcher or timeout)`);
    else if (!expected && list.length > 0) add('hook-unexpected', script, `unexpected hook: ${script} is installed but this install omits it (--skip-file-guard)`);
  };
  hookCheck('guard-git', true);
  hookCheck('guard-files', expectGuardFiles);
  hookCheck('session-version', true, 'SessionStart');
  for (const u of found.unknown) add('hook-unknown', null, `unrecognised hook entry in the pipeline hooks dir: ${JSON.stringify(u.handler)}`);

  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  for (const entry of ourAllowEntries(home)) {
    if (!allow.includes(entry)) add('allow-missing', entry, `allow entry missing: ${entry}`);
  }

  if (drift.length === before) {
    let merged = null;
    try { merged = mergeSettings(settings, { home, skipFileGuard: !expectGuardFiles }); } catch { /* shape problems surface at install */ }
    // Only PreToolUse is order-sensitive (guard-files must run last); other SessionStart entries may follow ours.
    if (merged && !isDeepStrictEqual(merged.hooks?.PreToolUse, settings.hooks?.PreToolUse)) {
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
