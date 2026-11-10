// The Fable floor: the oldest Fable model a review may be proven with on this machine (plan 2026-11-10, A1/A2/A4b).
// floor = max(MIN_FABLE, the newest Fable ever proven here), capped by an owner "hold". The registry lives in
// <accountHome>/.claude/pipeline-state/owner-go/model-floor/fable.json, inside the folder the frozen guard protects (agents cannot
// write it; the pipeline CLI, which they run but cannot steer, does). accountHome() is the passwd home, never $HOME.
// This module only decides and stores; wiring it into the arbiter, model-proof and preflight is done by their own modules.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { accountHome } from './paths.mjs';
import { LockTimeoutError, clearUnheld, readMachineId, withLock } from './locks.mjs';
import { seamValue } from './seams.mjs';
import { OWNER_GO_REL, realDirChain } from '../hooks/lib/owner-go.mjs';

// Shipped in the code so a missing or fresh registry is never "no floor". Bump it in a normal pipeline PR when a new Fable ships.
export const MIN_FABLE = 'claude-fable-5-2';
export const FLOOR_REL = `${OWNER_GO_REL}/model-floor`;
export const REGISTRY_FILE = 'fable.json';
export const LOCK_NAME = 'model-floor';
export const HISTORY_MAX = 10;
export const ALLOW_MAX = 10;
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
// An id the owner may allow by exact name (reset --allow-id): any claude-fable-* id, including one the parser cannot read yet.
const ALLOW_RE = /^claude-fable-[A-Za-z0-9._-]{1,80}$/;
export const isAllowableId = (id) => typeof id === 'string' && ALLOW_RE.test(id);
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
  if (r.allow !== undefined && (!Array.isArray(r.allow) || r.allow.length > ALLOW_MAX || r.allow.some((id) => !isAllowableId(id)))) return 'allow is malformed';
  return null;
}

// The floor from a registry (or none): max(MIN_FABLE, newest), capped by the hold.
function floorOf(registry) {
  let floor = MIN_FABLE;
  if (registry && compareVersions(parseModelId(registry.newest), parseModelId(floor)) > 0) floor = registry.newest;
  if (registry?.hold && compareVersions(parseModelId(floor), parseModelId(registry.hold)) > 0) floor = registry.hold;
  return canonical(floor);
}

// The Fable ids the owner allowed by exact name (reset --allow-id): accepted although the parser cannot read them (one it reads is judged by version
// like any other, and may raise the floor like any other). An allowance never raises the floor for an id the parser cannot read.
export const allowedIds = (registry) => (Array.isArray(registry?.allow) ? registry.allow : []);
// The allowed ids the parser can read now: their allowance does nothing any more (they are judged by version), so the owner should clear it.
export const readableAllowedIds = (registry) => allowedIds(registry).filter((id) => parseModelId(id) !== null);

// The version below which a recorded Fable proof is re-reviewed (staleness, supersession, fable-refresh): the registry's hold when it is set and
// below MIN_FABLE (an owner rollback must let the older proofs it admits complete a review), else MIN_FABLE.
export function reReviewThreshold(registry) {
  const hold = registry?.hold;
  return hold && compareVersions(parseModelId(hold), parseModelId(MIN_FABLE)) < 0 ? canonical(hold) : canonical(MIN_FABLE);
}

// The standing owner bypasses a registry holds, for `pipeline preflight`: [{ kind: 'allow', ids } | { kind: 'hold', hold }] (empty when there are none). An allowance
// (a non-empty `allow` list) and a hold below MIN_FABLE (it lowers the re-review threshold) both let a proof through that the shipped floor would refuse.
export function standingBypasses(registry) {
  const out = [];
  const ids = allowedIds(registry);
  if (ids.length > 0) out.push({ kind: 'allow', ids });
  const threshold = reReviewThreshold(registry);
  if (registry?.hold && threshold !== canonical(MIN_FABLE)) out.push({ kind: 'hold', hold: threshold });
  return out;
}

// What review-complete, the final gate, fable-refresh and the Fable diff scope compare recorded proofs against: { threshold, allow }.
// An unreadable registry falls back to the stricter MIN_FABLE with no allowed ids (the next apply reports the unreadable registry itself).
export function readReviewGate(opts = {}) {
  const read = readFloor(opts);
  return read.ok ? { threshold: reReviewThreshold(read.registry), allow: allowedIds(read.registry) } : { threshold: canonical(MIN_FABLE), allow: [] };
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

// { ok, older: [Fable ids below the floor], unparseable: [claude-fable-* ids that do not parse] }. Only the Fable family is judged. An id in `allow`
// (the owner's exact-name allowance) is never "unparseable"; it is also never "older" if the parser cannot read it, but one that parses and is below
// the floor is "older" all the same: the allowance covers what the parser cannot read, not a model a later floor has passed.
export function checkFloor({ models, floor, allow = [] }) {
  const want = parseModelId(floor);
  if (want?.family !== 'fable') throw codeError('model-floor-bad-floor', `the floor ${JSON.stringify(floor)} is not a Fable model id`);
  const older = [];
  const unparseable = [];
  for (const id of new Set((models ?? []).filter((m) => typeof m === 'string'))) {
    if (!id.startsWith('claude-fable-')) continue;
    const p = parseModelId(id);
    if (!p) { if (!allow.includes(id)) unparseable.push(id); }
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
    ...(allowedIds(current.registry).length > 0 ? { allow: allowedIds(current.registry) } : {}),
  };
  writeRegistry(opts, registry);
  return { raised: true, floor: floorOf(registry), registry };
}

// The machine-wide `model-floor` lock, kept in the registry's own folder (never PIPELINE_LOCK_DIR / the default lock dir), so processes with
// different $HOME values share it. fn({ dir, lock }) runs holding it (`lock` is the handle: holdsLock(lock) asks whether it is still ours). Waits up to waitMs, then throws code 'model-floor-busy'.
export async function withFloorLock({ waitMs = LOCK_WAIT_MS, pollMs = 100, ...opts } = {}, fn) {
  const dir = ensureDir(opts);
  const stateDir = path.join(opts.home ?? accountHome(), '.claude', 'pipeline-state');
  try {
    return await withLock(LOCK_NAME, (lock) => fn({ dir, lock }), { dir, waitMs, pollMs, machineId: readMachineId({ stateDir }) });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      throw codeError('model-floor-busy', `another review is updating the model floor (waited ${waitMs} ms): ${err.message.replace(/ To clear it by hand.*$/, '')}. Run the review again in a minute; if it persists, the owner runs \`pipeline model-floor reset --clear-lock --keep-floor\` (a bare \`--clear-lock\` also resets the learned floor to the shipped minimum)`, { cause: err });
    }
    throw err;
  }
}

// --clear-lock never takes a lock from a process that is still using it: the holder would go on to write under a floor it no longer protects.
// It inspects the lock and removes only that one (locks.mjs clearUnheld: reclaim guard, re-judged under it, the moved folder confirmed to be the
// one inspected, anything else put back), so a lock a review takes after the look survives. No lock => nothing is touched. Refused (model-floor-lock-live)
// while the recorded holder is on this machine and its pid is running; a dead holder, another machine's holder and a lock with no usable owner record
// may be removed. A read error on the lock (anything but a missing or unparseable owner.json) refuses, fail closed like tryAcquire:
// model-floor-lock-unreadable, naming the error code. Returns true when it removed the lock.
function clearFloorLock(dir, opts, lockHooks) {
  const lockDir = path.join(dir, `${LOCK_NAME}.lock`);
  let r;
  try {
    r = clearUnheld(LOCK_NAME, { dir, machineId: readMachineId({ stateDir: path.join(opts.home ?? accountHome(), '.claude', 'pipeline-state') }), hooks: lockHooks });
  } catch (err) {
    if (err?.strandedAt) {
      throw codeError('model-floor-lock-unreadable', `the floor lock ${lockDir} became unreadable after it was moved aside (${err.code ?? err.message}) and could not be put back: it is now at ${err.strandedAt}. When no review is running, remove that folder by hand; otherwise move it back to ${lockDir}`, { cause: err, strandedAt: err.strandedAt });
    }
    throw codeError('model-floor-lock-unreadable', `the floor lock ${lockDir} cannot be inspected (${err.code ?? err.message}), so it is not cleared: a review that holds it could lose it. Fix the folder's permissions and run --clear-lock again, or, when no review is running, remove that folder by hand`, { cause: err });
  }
  if (r.state === 'live') {
    throw codeError('model-floor-lock-live', `the floor lock is held by a running process (pid ${r.owner.pid}, since ${r.owner.startedAt}). Confirm pid ${r.owner.pid} is a pipeline process (\`ps -p ${r.owner.pid} -o command=\`): if it is, stop it or wait for it to finish, then run --clear-lock again; if it is not (the pid was reused by an unrelated program), remove the lock folder ${lockDir} by hand. Clearing a lock its holder still uses would let that review save a proof the floor no longer allows`, { holderPid: r.owner.pid });
  }
  if (r.state === 'changed') {
    throw codeError('model-floor-lock-changed', `the floor lock ${lockDir} changed while it was being cleared (a review took it), so it was left in place${r.restored === false ? ' (the lock we moved aside could not be put back: look for a model-floor.lock.stale-* folder beside it)' : ''}. Run --clear-lock again if it is still stuck`);
  }
  if (r.state === 'busy') {
    throw codeError('model-floor-lock-busy', `the floor lock ${lockDir} is busy, so nothing was cleared: either another process is recovering or reclaiming it right now, or the folder is under a minute old and has no owner record yet (a review starting up, or one that died there). Run --clear-lock again within a minute. If it still refuses after a minute and no pipeline process is running (a folder dated in the future by a skewed clock never ages), remove that folder by hand`);
  }
  return r.state === 'cleared';
}

// Owner recovery (the CLI wrapper adds the owner-only check): rewrite the registry to the code constant. `hold` (a Fable id) sets the ceiling the
// floor cannot rise above; `clearHold` removes it; with neither, an existing readable hold is kept. `clearLock` first removes the floor lock
// folder (for a lock another host or an unreadable record left behind; a dead holder's lock is reclaimed by the lock itself), only the one it inspected
// (clearFloorLock above; `lockHooks` is its test-only seam). It refuses, with model-floor-lock-live, while the holder is a running process on this machine
// (confirm it is a pipeline process, then stop it or wait; a recycled pid's folder is removed by hand): that holds for the plain and the keepFloor form.
// `allowId` (Fable ids, exact names) adds to the registry's `allow` list (at most ALLOW_MAX): the review accepts those ids although the parser cannot
// read them (an id the parser reads is judged by version like any other: the allowance never admits one below the floor); `clearAllow` empties it;
// `removeAllow` removes exactly those ids (each must be on the list now, else model-floor-bad-allow naming the list; not with clearAllow, and not an id
// that allowId adds in the same call). An existing readable list is kept otherwise. An allowance never raises the floor for an id the parser cannot read.
// `keepFloor` (only with clearLock, nothing else) removes the lock folder and rewrites nothing: the registry, floor and allowances stay as they are.
// A call that carries allowId, removeAllow and/or clearAllow and no hold or clearHold is not a reset (`clearLock` alongside is fine: it only removes a lock folder and
// says nothing about wanting a reset; a bare clearLock stays a plain reset): it changes `allow` and keeps the learned floor
// (newest, provenAt, claudeCode, transcript, history) and the hold, so allowing an unreadable id, and clearing it later, never forgets what proofs raised.
// A corrupt registry has no floor worth keeping: that call throws model-floor-unreadable and the owner runs a plain reset first.
// -> { floor, registry, file, clearedLock }.
export async function resetFloor({ hold, clearHold = false, allowId = [], removeAllow = [], clearAllow = false, clearLock = false, keepFloor = false, lockHooks, now, waitMs = 5000, ...opts } = {}) {
  if (hold !== undefined && hold !== null && clearHold) throw codeError('model-floor-bad-hold', 'use --hold or --clear-hold, not both');
  if (hold !== undefined && hold !== null && !isFableId(hold)) throw codeError('model-floor-bad-hold', `cannot hold the floor at ${JSON.stringify(hold)}: not a Fable model id`);
  if (clearAllow && allowId.length > 0) throw codeError('model-floor-bad-allow', 'use --allow-id or --clear-allow, not both');
  for (const id of allowId) {
    if (!isAllowableId(id)) throw codeError('model-floor-bad-allow', `cannot allow ${JSON.stringify(id)}: not a claude-fable-* model id (letters, digits, . _ - only)`);
  }
  if (clearAllow && removeAllow.length > 0) throw codeError('model-floor-bad-allow', 'use --remove-allow or --clear-allow, not both');
  const both = removeAllow.filter((id) => allowId.includes(id));
  if (both.length > 0) throw codeError('model-floor-bad-allow', `${both.join(', ')} is in both --allow-id and --remove-allow`);
  const hasHold = (hold !== undefined && hold !== null) || clearHold;
  const allowOnly = (allowId.length > 0 || removeAllow.length > 0 || clearAllow) && !hasHold;
  if (keepFloor && (!clearLock || hasHold || allowId.length > 0 || removeAllow.length > 0 || clearAllow)) {
    throw codeError('model-floor-bad-keep', '--keep-floor goes with --clear-lock alone (it removes the lock and rewrites nothing)');
  }
  const dir = ensureDir(opts);
  if (keepFloor) {
    const current = readFloor(opts);
    if (!current.ok) {
      throw codeError('model-floor-unreadable', `${current.message.replace(/; reviews are blocked until.*$/, '')}: --keep-floor keeps the learned floor and there is none to keep; run \`pipeline model-floor reset --clear-lock\` (a plain reset)`);
    }
    const clearedLock = clearFloorLock(dir, opts, lockHooks);
    return { floor: current.floor, registry: current.registry, file: registryFile(dir), clearedLock };
  }
  let clearedLock = false;
  if (clearLock) {
    clearedLock = clearFloorLock(dir, opts, lockHooks);
  }
  return withFloorLock({ ...opts, waitMs }, () => {
    const current = readFloor(opts); // a corrupt file is exactly what reset replaces: its hold is lost with it
    if (allowOnly && !current.ok) {
      throw codeError('model-floor-unreadable', `${current.message.replace(/; reviews are blocked until.*$/, '')}: --allow-id / --remove-allow / --clear-allow keep the learned floor and there is none to keep; run a plain \`pipeline model-floor reset\` first, then allow the id`);
    }
    let keep = current.ok ? current.registry?.hold ?? null : null;
    if (clearHold) keep = null;
    else if (hold) keep = canonical(hold);
    const listed = current.ok ? allowedIds(current.registry) : [];
    const unknown = removeAllow.filter((id) => !listed.includes(id));
    if (unknown.length > 0) throw codeError('model-floor-bad-allow', `cannot remove ${unknown.join(', ')}: not on the allow list (${listed.length > 0 ? listed.join(', ') : 'it is empty'})`);
    const allow = clearAllow ? [] : [...new Set([...listed.filter((id) => !removeAllow.includes(id)), ...allowId])];
    if (allow.length > ALLOW_MAX) throw codeError('model-floor-bad-allow', `at most ${ALLOW_MAX} allowed ids (${allow.length} asked): remove one with --remove-allow <id> (or all with --clear-allow) first`);
    const { allow: _dropped, ...learned } = current.ok && current.registry ? current.registry : {};
    const registry = allowOnly
      ? { version: 1, newest: canonical(MIN_FABLE), provenAt: null, claudeCode: null, transcript: null, history: [], hold: null, ...learned, ...(allow.length > 0 ? { allow } : {}) }
      : { version: 1, newest: canonical(MIN_FABLE), provenAt: null, claudeCode: null, transcript: null, history: [], hold: keep, ...(allow.length > 0 ? { allow } : {}) };
    writeRegistry(opts, registry);
    return { floor: floorOf(registry), registry, file: registryFile(dir), clearedLock };
  });
}
