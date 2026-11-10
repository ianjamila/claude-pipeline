// The Fable floor as the model proof applies it (plan 2026-11-10, A2). model-floor.mjs decides and stores; this module is what `arbiter apply` and
// `model-proof` call: which Fable models a transcript shows, whether any is below the floor (and what to tell the person), who may raise the
// floor, and the test-only pause between the floor compare and the publish. Every home / root / env is injectable for the in-process tests.
import fs from 'node:fs';
import path from 'node:path';
import { accountHome } from './paths.mjs';
import { compareSemver, installedVersion, runningVersion } from './claude-code-version.mjs';
import { FLOOR_DIR_ENV, MIN_FABLE, allowedIds, checkFloor, compareVersions, parseModelId, readFloor } from './model-floor.mjs';
import { isInstalledCopy, pipelineRoot, seamValue } from './seams.mjs';

// Test-only seams (a repo checkout honours them, an installed copy ignores them, like PIPELINE_TEST_MODE):
//   PIPELINE_ACCOUNT_PROJECTS_DIR  the folder treated as <accountHome>/.claude/projects when deciding who may raise the floor; it only matters
//                                  together with PIPELINE_MODEL_FLOOR_DIR (a checkout may raise only a floor that is redirected to a scratch folder)
//   PIPELINE_TEST_FLOOR_PAUSE      <base>: apply writes <base>.reached after the floor compare and waits for <base>.go (test mode only)
//   PIPELINE_TEST_FLOOR_WAIT_MS    how long to wait for the floor lock (the shipped wait is 30 s)
export const PROJECTS_DIR_ENV = 'PIPELINE_ACCOUNT_PROJECTS_DIR';
export const FLOOR_PAUSE_ENV = 'PIPELINE_TEST_FLOOR_PAUSE';
export const FLOOR_WAIT_ENV = 'PIPELINE_TEST_FLOOR_WAIT_MS';

const FABLE_PREFIX = 'claude-fable-';
// The Fable model ids a proof saw (proof.models is { model id: lines }).
export const fableModelsOf = (models) => Object.keys(models ?? {}).filter((m) => m.startsWith(FABLE_PREFIX));

// The newest of a list of Claude Code versions (null when none is a version).
function newestVersion(versions) {
  let best = null;
  for (const v of versions ?? []) {
    if (compareSemver(v, v) === null) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

// What to do about a stale proof, from the transcript alone (no memory of an earlier stop): a terminal whose Claude Code build is older than the
// installed one needs a restart; otherwise the installed build is no newer (or unknown) and only an update, or the owner's reset, can help.
export function floorAdvice({ claudeCodeVersions, env, deps } = {}) {
  const built = newestVersion(claudeCodeVersions);
  const installed = installedVersion(env, deps);
  if (built !== null && installed !== null && compareSemver(built, installed) < 0) {
    return `restart this terminal (it runs Claude Code ${built}, the installed build is ${installed}), then run the review again`;
  }
  return 'update Claude Code, or the owner runs `pipeline model-floor reset` in a plain terminal if the floor is wrong, then run the review again';
}

// A claude-fable-* id the parser cannot read: only a pipeline update, or the owner's exact-name allowance (model-floor reset --allow-id), clears it.
export const UNRECOGNISED_ADVICE = 'do not run the review again yet: update the pipeline, or the owner runs `pipeline model-floor reset --allow-id <the exact claude-fable-… id>` in a plain terminal (then `--clear-allow` once the parser knows the id)';
const fableOrder = (a, b) => compareVersions(parseModelId(a) ?? { major: 0, minor: 0 }, parseModelId(b) ?? { major: 0, minor: 0 });

// Judge the Fable models of a proof against the floor (read-only).
//   -> { applies: false }                                     no Fable on any line: the floor does not apply
//   -> { applies: true, ok, floor, seen, older, errors[], error, restartRequired, advice, floorOpts, allowed, allowedSeen, heldBelowMin }
// `allowed` = the seen ids that pass ONLY because the owner allowed them (the parser cannot read them); `allowedSeen` = every seen id on the allow list (none of
// them raises the floor); `heldBelowMin` = the owner's hold when a seen id is below MIN_FABLE and passes only because the hold lowered the floor, else null.
// `error` is the machine-readable code of the first failure: 'stale-model' | 'unrecognised-fable' | 'model-floor-unreadable'; every failure carries
// `advice`. Fails closed on an unreadable registry and on a claude-fable-* id the parser cannot read unless the owner allowed that exact id.
export function judgeFloor({ models, claudeCodeVersions = [], env, floorOpts = {}, deps } = {}) {
  const seen = fableModelsOf(models).sort(fableOrder);
  if (seen.length === 0) return { applies: false };
  const opts = { env, ...floorOpts };
  const read = readFloor(opts);
  if (!read.ok) {
    return {
      applies: true, ok: false, floor: null, seen, older: [], errors: [read.message], error: read.error, restartRequired: false,
      advice: 'the owner runs `pipeline model-floor reset` in a plain terminal', unreadable: true,
    };
  }
  const allow = allowedIds(read.registry);
  const check = checkFloor({ models: seen, floor: read.floor, allow });
  const errors = [];
  let error = null;
  let restartRequired = false;
  let advice;
  if (check.older.length > 0) {
    restartRequired = true;
    error = 'stale-model';
    const running = runningVersion(env) ?? newestVersion(claudeCodeVersions);
    const where = running ? `This terminal runs Claude Code ${running}: restart it` : 'Restart this terminal';
    errors.push(`older Fable ${check.older.join(', ')} (this machine's floor: ${read.floor}). ${where} (or update Claude Code), then run the review again.`);
    advice = floorAdvice({ claudeCodeVersions, env, deps });
  }
  for (const id of check.unparseable) {
    errors.push(`unrecognised Fable version id ${id}: update the pipeline`);
    error ??= 'unrecognised-fable';
  }
  if (check.unparseable.length > 0) advice ??= UNRECOGNISED_ADVICE;
  const hold = read.registry?.hold ?? null;
  const heldBelowMin = hold && compareVersions(parseModelId(hold), parseModelId(MIN_FABLE)) < 0
    && seen.some((id) => { const p = parseModelId(id); return p !== null && compareVersions(p, parseModelId(MIN_FABLE)) < 0 && !check.older.includes(id); })
    ? hold : null;
  return {
    applies: true, ok: check.ok, floor: read.floor, seen,
    allowed: seen.filter((id) => allow.includes(id) && parseModelId(id) === null), allowedSeen: seen.filter((id) => allow.includes(id)), heldBelowMin, older: check.older, unparseable: check.unparseable, errors, error, restartRequired,
    ...(advice ? { advice } : {}), floorOpts: opts,
  };
}

// The fields a floor adds to a command's output: the failure fields on a failed floor; on a passed one, `floor: {newest, allowed, heldBelowMin}` only when
// an owner allowance or a hold below MIN_FABLE is what let the proof pass (a standing bypass is never silent).
export const floorOutput = (judged) => {
  if (judged?.applies && (judged.restartRequired || judged.errors?.length > 0)) {
    return {
      ...(judged.error ? { error: judged.error } : {}),
      ...(judged.restartRequired ? { restartRequired: true } : {}),
      ...(judged.floor ? { floor: { newest: judged.floor, seen: judged.seen } } : {}),
      ...(judged.advice ? { advice: judged.advice } : {}),
    };
  }
  const bypass = floorBypass(judged);
  return bypass ? { floor: { newest: judged.floor, ...bypass } } : {};
};

// { allowed: [ids], heldBelowMin: hold|null } when a passed floor judgement rests on an owner allowance or a hold below MIN_FABLE, else null.
export const floorBypass = (judged) => (judged?.applies && judged.ok && (judged.allowed?.length > 0 || judged.heldBelowMin)
  ? { allowed: judged.allowed ?? [], heldBelowMin: judged.heldBelowMin ?? null }
  : null);

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// May this apply raise the floor? Only without --projects-dir, only for a transcript under the account's own projects root (realpath compare;
// the passwd home, never $HOME), and only from the installed copy at <home>/.claude/pipeline or a checkout whose floor folder is redirected by the
// seam. -> { ok: true } | { ok: false, why }. A fixture transcript, a steered $HOME or a stray checkout can never push the real floor up.
export function mayRaiseFloor({ transcript, projectsDirGiven, env, home = accountHome(), root = pipelineRoot() } = {}) {
  if (projectsDirGiven) return { ok: false, why: '--projects-dir was given' };
  const installed = isInstalledCopy(root);
  const seamOpts = { root };
  if (installed) {
    const here = real(root);
    const expected = real(path.join(home, '.claude', 'pipeline'));
    if (here === null || expected === null || here !== expected) return { ok: false, why: 'this is not the installed copy at <home>/.claude/pipeline' };
  } else if (!seamValue(FLOOR_DIR_ENV, env, seamOpts)) {
    return { ok: false, why: 'a repo checkout raises only a floor redirected by PIPELINE_MODEL_FLOOR_DIR' };
  }
  const projectsRoot = (!installed && seamValue(PROJECTS_DIR_ENV, env, seamOpts)) || path.join(home, '.claude', 'projects');
  const rootReal = real(projectsRoot);
  const fileReal = typeof transcript === 'string' ? real(transcript) : null;
  if (rootReal === null || fileReal === null || !inside(fileReal, rootReal)) return { ok: false, why: "the transcript is not under the account's projects folder" };
  return { ok: true };
}

// How long to wait for the floor lock: the library default, or the test seam's value.
export function floorWaitMs(env, root = pipelineRoot()) {
  const raw = seamValue(FLOOR_WAIT_ENV, env, { root });
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Test-mode pause between the floor compare and the publish: write <base>.reached, then wait until <base>.go exists (at most `maxMs`).
// A no-op unless PIPELINE_TEST_MODE=1 and the seam variable are both honoured (a repo checkout).
export async function floorPauseSeam(env, { root = pipelineRoot(), maxMs = 30_000, pollMs = 20 } = {}) {
  if (seamValue('PIPELINE_TEST_MODE', env, { root }) !== '1') return false;
  const base = seamValue(FLOOR_PAUSE_ENV, env, { root });
  if (!base) return false;
  fs.writeFileSync(`${base}.reached`, `${process.pid}\n`);
  const deadline = Date.now() + maxMs;
  while (!fs.existsSync(`${base}.go`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  return true;
}
