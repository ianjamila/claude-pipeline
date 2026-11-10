// The Fable floor: the oldest Fable model a review may be proven with on this machine (plan 2026-11-10, A1/A2/A4b).
// floor = max(MIN_FABLE, the newest Fable ever proven here), capped by an owner "hold". The registry lives in
// <accountHome>/.claude/pipeline-state/owner-go/model-floor/fable.json, inside the folder the frozen guard protects (agents cannot
// write it; the pipeline CLI, which they run but cannot steer, does). accountHome() is the passwd home, never $HOME.
// This module only decides and stores; wiring it into the arbiter, model-proof and preflight is done by their own modules.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { accountHome } from './paths.mjs';
import { LockTimeoutError, readMachineId, withLock } from './locks.mjs';
import { seamValue } from './seams.mjs';
import { OWNER_GO_REL, realDirChain } from '../hooks/lib/owner-go.mjs';

// Shipped in the code so a missing or fresh registry is never "no floor". Bump it in a normal pipeline PR when a new Fable ships.
export const MIN_FABLE = 'claude-fable-5-2';
export const FLOOR_REL = `${OWNER_GO_REL}/model-floor`;
export const REGISTRY_FILE = 'fable.json';
export const LOCK_NAME = 'model-floor';
export const HISTORY_MAX = 10;
export const LOCK_WAIT_MS = 30_000;
const REGISTRY_MAX_BYTES = 64 * 1024;
const DIR_ENV = 'PIPELINE_MODEL_FLOOR_DIR';
export const FLOOR_DIR_ENV = DIR_ENV;

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
// claude-<family>-<major>[-<minor>][-YYYYMMDD]: the minor is at most 4 digits, so an 8-digit date is never read as one.
const MODEL_RE = new RegExp(`^claude-(${FAMILIES.join('|')})-(\\d{1,3})(?:-(\\d{1,4}))?(?:-\\d{8})?$`);

export function parseModelId(id) {
  const m = typeof id === 'string' ? MODEL_RE.exec(id) : null;
  return m ? { family: m[1], major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]) } : null;
}

// -1 / 0 / 1 on {major, minor}.
export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

const isFableId = (id) => parseModelId(id)?.family === 'fable';
// The id without its date suffix, in the shape the registry stores ("claude-fable-5-2"; minor 0 is left out: "claude-fable-5").
const canonical = (id) => {
  const p = parseModelId(id);
  return p.minor === 0 ? `claude-${p.family}-${p.major}` : `claude-${p.family}-${p.major}-${p.minor}`;
};
const codeError = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

// ---- where the registry lives ------------------------------------------------------------------------------------------------------
// `dir` (an injected folder, for in-process tests) wins; else $PIPELINE_MODEL_FLOOR_DIR, honoured ONLY by a repo checkout (an installed
// copy ignores it with one stderr warning, like PIPELINE_TEST_MODE; independent of PIPELINE_TEST_MODE itself); else the account's folder
// (`home` is injectable; it defaults to accountHome(), never os.homedir()).
export function floorDir({ dir, home, env, root, warn } = {}) {
  if (dir) return path.resolve(dir);
  const seamOpts = {};
  if (root !== undefined) seamOpts.root = root;
  if (warn !== undefined) seamOpts.warn = warn;
  const override = seamValue(DIR_ENV, env, seamOpts);
  if (override) return path.resolve(override);
  return path.join(home ?? accountHome(), ...FLOOR_REL.split('/'));
}
const registryFile = (dir) => path.join(dir, REGISTRY_FILE);

// Create the folder through owner-go's real-directory chain: every level must be a real directory, never a symlink. The account folder is
// checked from <home>/.claude down; an override folder only from its own name (its parent is whatever the test or checkout chose).
function ensureDir(opts) {
  const dir = floorDir(opts);
  const standard = !opts.dir && dir === path.join(opts.home ?? accountHome(), ...FLOOR_REL.split('/'));
  let ok;
  if (standard) ok = fs.existsSync(opts.home ?? accountHome()) && realDirChain(opts.home ?? accountHome(), FLOOR_REL);
  else {
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch { /* realDirChain reports it */ }
    ok = realDirChain(path.dirname(dir), path.basename(dir));
  }
  if (!ok) throw codeError('model-floor-unwritable', `cannot create the model floor folder ${dir}: a level of it is missing, not a directory, or a symlink`);
  return dir;
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------
const unreadable = (file, why) => ({
  ok: false,
  floor: null,
  registry: null,
  error: 'model-floor-unreadable',
  message: `the model floor registry ${file} is unreadable (${why}); reviews are blocked until the owner runs \`pipeline model-floor reset\` in a plain terminal`,
});

const strOrNull = (v) => v === undefined || v === null || typeof v === 'string';
// null = valid; else why not.
function schemaProblem(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not a JSON object';
  if (r.version !== 1) return `unknown version ${JSON.stringify(r.version)}`;
  if (!isFableId(r.newest)) return 'newest is not a Fable model id';
  if (!strOrNull(r.provenAt) || !strOrNull(r.claudeCode) || !strOrNull(r.transcript)) return 'provenAt / claudeCode / transcript must be strings';
  if (!Array.isArray(r.history) || r.history.length > HISTORY_MAX || r.history.some((h) => !h || typeof h !== 'object' || !isFableId(h.model))) return 'history is malformed';
  if (r.hold !== undefined && r.hold !== null && !isFableId(r.hold)) return 'hold is not a Fable model id';
  return null;
}

// The floor from a registry (or none): max(MIN_FABLE, newest), capped by the hold.
function floorOf(registry) {
  let floor = MIN_FABLE;
  if (registry && compareVersions(parseModelId(registry.newest), parseModelId(floor)) > 0) floor = registry.newest;
  if (registry?.hold && compareVersions(parseModelId(floor), parseModelId(registry.hold)) > 0) floor = registry.hold;
  return canonical(floor);
}

// { ok: true, floor, registry } (registry null when the file is absent: floor = MIN_FABLE) | { ok: false, error: 'model-floor-unreadable', message }.
export function readFloor(opts = {}) {
  const file = registryFile(floorDir(opts));
  let text;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return unreadable(file, 'not a regular file');
    if (st.size > REGISTRY_MAX_BYTES) return unreadable(file, 'too large');
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, floor: canonical(MIN_FABLE), registry: null, error: null };
    return unreadable(file, err?.code ?? err?.message ?? 'read failed');
  }
  let registry;
  try { registry = JSON.parse(text); } catch { return unreadable(file, 'not valid JSON'); }
  const problem = schemaProblem(registry);
  if (problem) return unreadable(file, problem);
  return { ok: true, floor: floorOf(registry), registry, error: null };
}

// { ok, older: [Fable ids below the floor], unparseable: [claude-fable-* ids that do not parse] }. Only the Fable family is judged.
export function checkFloor({ models, floor }) {
  const want = parseModelId(floor);
  if (want?.family !== 'fable') throw codeError('model-floor-bad-floor', `the floor ${JSON.stringify(floor)} is not a Fable model id`);
  const older = [];
  const unparseable = [];
  for (const id of new Set((models ?? []).filter((m) => typeof m === 'string'))) {
    if (!id.startsWith('claude-fable-')) continue;
    const p = parseModelId(id);
    if (!p) unparseable.push(id);
    else if (p.family === 'fable' && compareVersions(p, want) < 0) older.push(id);
  }
  return { ok: older.length === 0 && unparseable.length === 0, older, unparseable };
}

// ---- writing -------------------------------------------------------------------------------------------------------------------------
// Atomic: a private tmp file in the same folder, then rename over fable.json.
function writeRegistry(opts, registry) {
  const dir = ensureDir(opts);
  const file = registryFile(dir);
  const tmp = path.join(dir, `${REGISTRY_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw codeError('model-floor-unwritable', `cannot write the model floor registry ${file}: ${err?.code ?? err?.message}`, { cause: err });
  }
}

const isoOf = (now) => new Date(now ?? Date.now()).toISOString();

// Raise the floor to `model` (a Fable id) when it is newer than the current floor. The caller holds withFloorLock around its read-compare-write.
// -> { raised: true, floor, registry } | { raised: false, reason: 'not-newer' | 'above-hold', floor }. Throws model-floor-unreadable (the registry
// is corrupt: nothing is overwritten), model-floor-bad-model, model-floor-unwritable.
export function raiseFloor({ model, claudeCode = null, transcript = null, now, ...opts } = {}) {
  if (!isFableId(model)) throw codeError('model-floor-bad-model', `cannot raise the model floor to ${JSON.stringify(model)}: not a Fable model id`);
  const current = readFloor(opts);
  if (!current.ok) throw codeError(current.error, current.message);
  const want = parseModelId(model);
  if (compareVersions(want, parseModelId(current.floor)) <= 0) return { raised: false, reason: 'not-newer', floor: current.floor };
  const hold = current.registry?.hold ?? null;
  if (hold && compareVersions(want, parseModelId(hold)) > 0) return { raised: false, reason: 'above-hold', floor: current.floor, hold };
  const at = isoOf(now);
  const newest = canonical(model);
  const registry = {
    version: 1,
    newest,
    provenAt: at,
    claudeCode: claudeCode ?? null,
    transcript: transcript ?? null,
    history: [...(current.registry?.history ?? []), { model: newest, at, claudeCode: claudeCode ?? null, transcript: transcript ?? null }].slice(-HISTORY_MAX),
    hold,
  };
  writeRegistry(opts, registry);
  return { raised: true, floor: floorOf(registry), registry };
}

// The machine-wide `model-floor` lock, kept in the registry's own folder (never PIPELINE_LOCK_DIR / the default lock dir), so processes with
// different $HOME values share it. fn({ dir }) runs holding it. Waits up to waitMs, then throws code 'model-floor-busy'.
export async function withFloorLock({ waitMs = LOCK_WAIT_MS, pollMs = 100, ...opts } = {}, fn) {
  const dir = ensureDir(opts);
  const stateDir = path.join(opts.home ?? accountHome(), '.claude', 'pipeline-state');
  try {
    return await withLock(LOCK_NAME, () => fn({ dir }), { dir, waitMs, pollMs, machineId: readMachineId({ stateDir }) });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      throw codeError('model-floor-busy', `another review is updating the model floor (waited ${waitMs} ms): ${err.message.replace(/ To clear it by hand.*$/, '')}. Run the review again in a minute; if it persists, the owner runs \`pipeline model-floor reset --clear-lock\``, { cause: err });
    }
    throw err;
  }
}

// Owner recovery (the CLI wrapper adds the owner-only check): rewrite the registry to the code constant. `hold` (a Fable id) sets the ceiling the
// floor cannot rise above; `clearHold` removes it; with neither, an existing readable hold is kept. `clearLock` first removes the floor lock
// folder (for a lock a live-looking process or another host left behind; a dead holder's lock is reclaimed by the lock itself).
// -> { floor, registry, file, clearedLock }.
export async function resetFloor({ hold, clearHold = false, clearLock = false, now, waitMs = 5000, ...opts } = {}) {
  if (hold !== undefined && hold !== null && clearHold) throw codeError('model-floor-bad-hold', 'use --hold or --clear-hold, not both');
  if (hold !== undefined && hold !== null && !isFableId(hold)) throw codeError('model-floor-bad-hold', `cannot hold the floor at ${JSON.stringify(hold)}: not a Fable model id`);
  const dir = ensureDir(opts);
  let clearedLock = false;
  if (clearLock) {
    const lockDir = path.join(dir, `${LOCK_NAME}.lock`);
    clearedLock = fs.existsSync(lockDir);
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  return withFloorLock({ ...opts, waitMs }, () => {
    const current = readFloor(opts); // a corrupt file is exactly what reset replaces: its hold is lost with it
    let keep = current.ok ? current.registry?.hold ?? null : null;
    if (clearHold) keep = null;
    else if (hold) keep = canonical(hold);
    const registry = { version: 1, newest: canonical(MIN_FABLE), provenAt: null, claudeCode: null, transcript: null, history: [], hold: keep };
    writeRegistry(opts, registry);
    return { floor: floorOf(registry), registry, file: registryFile(dir), clearedLock };
  });
}
