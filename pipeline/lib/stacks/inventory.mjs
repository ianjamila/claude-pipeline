// Docker inventory of Supabase projects, for stack-stop. Every running or stopped container the Supabase CLI labelled with
// `com.supabase.cli.project` is grouped into one Stack per project. Everything here answers ok | unknown (fail closed):
// a dead docker daemon is a definite "no stacks", but a timeout, a signal, a spawn error, bad JSON or an exhausted
// deadline is unknown, and nothing in this file throws. readInventory reads no environment: the caller passes the docker
// binary and the deadline. resolveDocker is the one place the PIPELINE_DOCKER test seam is read.
//
// A container without the `com.supabase.cli.workdir` label (the live DRMed stack has only the project label), or one whose
// project's containers disagree about the workdir, has workdir null: "workdir unknown", never a guess, and the deciders
// treat that as report-only. The stack workdir is the directory holding supabase/config.toml; its folder is that directory's basename (e.g. sa-corrections.stack).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as realRun, findOnPosixPath } from '../proc.mjs';
import { isShared } from './config.mjs';
import { stacksSeam } from './paths.mjs';
import { ok, unknown } from './result.mjs';

export const DOCKER_DOWN_RE = /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock.*(no such file|connection refused)/i;

const PROJECT_LABEL = 'com.supabase.cli.project';
const WORKDIR_LABEL = 'com.supabase.cli.workdir';
const DB_DATA_DIR = '/var/lib/postgresql/data';
const CALL_CAP_MS = 10000;
const MIN_REMAINING_MS = 500; // under this, a docker call is not worth starting
const DEFAULT_MAX_AGE_MS = 60000;

// The docker binary for this process: the PIPELINE_DOCKER test seam (isolated runs in the checkout only, see stacksSeam),
// else `docker` found on PATH or in the usual install dirs (a hook's PATH often lacks /opt/homebrew/bin), else the bare
// name so a missing docker fails as a spawn error (unknown), never as "no stacks". Windows: the bare name.
export function resolveDocker({ env = process.env, home = os.homedir(), root, platform = process.platform, fallbackDirs, warn } = {}) {
  const seam = stacksSeam('PIPELINE_DOCKER', env, { root, home, ...(warn ? { warn } : {}) });
  if (seam !== undefined && String(seam).trim() !== '') return String(seam).trim();
  if (platform === 'win32') return 'docker';
  const dirs = fallbackDirs ?? ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.orbstack', 'bin')];
  return findOnPosixPath('docker', env?.PATH, dirs) ?? 'docker';
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const stripSlash = (n) => String(n ?? '').replace(/^\//, '');

// Milliseconds for the next docker call, or null when the deadline leaves too little time.
function callBudget(deadlineAt, now) {
  if (deadlineAt === undefined || deadlineAt === null) return CALL_CAP_MS;
  const remaining = deadlineAt - now();
  return remaining < MIN_REMAINING_MS ? null : Math.min(CALL_CAP_MS, remaining);
}

// One docker call -> { r } or { fail: unknown-result } or { down: true }.
function dockerCall(run, docker, args, { deadlineAt, now }) {
  const timeoutMs = callBudget(deadlineAt, now);
  if (timeoutMs === null) return { fail: unknown('deadline') };
  let r;
  try {
    r = run(docker, args, { timeoutMs });
  } catch (err) {
    return { fail: unknown(`docker ${args[0]} could not run: ${err?.message ?? err}`) };
  }
  if (!r || typeof r !== 'object') return { fail: unknown(`docker ${args[0]} returned nothing`) };
  if (r.timedOut) return { fail: unknown(`docker ${args[0]} timed out`) };
  if (r.signal) return { fail: unknown(`docker ${args[0]} ended by signal ${r.signal}`) };
  if (r.code !== 0) {
    const stderr = String(r.stderr ?? '');
    if (DOCKER_DOWN_RE.test(stderr)) return { down: true };
    return { fail: unknown(`docker ${args[0]} exit ${r.code}: ${stderr.trim().split('\n')[0]}`), exited: r };
  }
  return { r };
}

// True when stderr is nothing but "No such object" lines: docker inspect names each id that vanished between `ps` and
// `inspect` (the Supabase CLI removes containers on stop) and still prints the JSON array for the ids that exist.
const NO_SUCH_OBJECT = /no such (object|container)/i;
function onlyNoSuchObject(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => NO_SUCH_OBJECT.test(l));
}

function hostPorts(c) {
  const out = [];
  for (const bindings of Object.values(c?.NetworkSettings?.Ports ?? {})) {
    for (const b of asArray(bindings)) {
      const n = Number(b?.HostPort);
      if (Number.isInteger(n) && n > 0 && n <= 65535) out.push(n);
    }
  }
  return out;
}

const volumeMounts = (c) => asArray(c?.Mounts).filter((m) => m?.Type === 'volume' && typeof m.Name === 'string' && m.Name);

function realWorkdir(label, realpath) {
  try {
    return { workdir: realpath(label), exists: true };
  } catch {
    return { workdir: label, exists: false };
  }
}

function buildStack(project, list, { cfg, realpath }) {
  const dbName = `supabase_db_${project}`.toLowerCase();
  const db = list.find((c) => stripSlash(c.Name).toLowerCase() === dbName) ?? null;
  const labels = [...new Set(list.map((c) => c?.Config?.Labels?.[WORKDIR_LABEL]).filter((w) => typeof w === 'string' && w.trim() !== ''))];
  let workdir = null;
  let workdirExists = false;
  if (labels.length > 0) {
    const resolved = labels.map((l) => realWorkdir(l, realpath));
    const distinct = [...new Set(resolved.map((r) => r.workdir))];
    // all containers carry the same (real) workdir, or the stack's workdir is unknown
    if (distinct.length === 1) ({ workdir, exists: workdirExists } = resolved[0]);
  }
  const dbData = db ? volumeMounts(db).find((m) => m.Destination === DB_DATA_DIR) : null;
  const volumes = [...new Set(list.flatMap((c) => volumeMounts(c).map((m) => m.Name)))].sort();
  return {
    project,
    workdir,
    workdirExists,
    folder: workdir === null ? null : path.basename(workdir),
    shared: isShared({ project, workdir }, cfg),
    generation: db ? { id: String(db.Id), startedAt: String(db.State?.StartedAt ?? '') } : null,
    containers: list.map((c) => ({ id: String(c.Id), name: stripSlash(c.Name), running: Boolean(c.State?.Running), startedAt: String(c.State?.StartedAt ?? '') })),
    ports: [...new Set(list.flatMap(hostPorts))].sort((a, b) => a - b),
    volumes,
    dbVolume: dbData ? dbData.Name : null,
  };
}

// ok({ dockerDown, stacks }) | unknown. `docker` is the binary to run; each call gets min(10 s, time left until
// `deadlineAt`) and fewer than 500 ms left is unknown('deadline').
export function readInventory({ run = realRun, cfg, docker = 'docker', deadlineAt, now = Date.now, realpath = fs.realpathSync } = {}) {
  try {
    // ps then inspect. A container removed in between makes inspect exit 1 with only "No such object" errors, yet its stdout is
    // still the JSON array of the survivors (the missing ones are simply gone). When that stdout is not usable, ps+inspect is
    // run once more (inside the same deadline) before answering unknown; any other inspect error stays unknown.
    let out = null;
    for (let attempt = 1; attempt <= 2 && out === null; attempt += 1) {
      const ps = dockerCall(run, docker, ['ps', '--all', '--filter', `label=${PROJECT_LABEL}`, '--format', '{{.ID}}'], { deadlineAt, now });
      if (ps.fail) return ps.fail;
      if (ps.down) return ok({ dockerDown: true, stacks: [] });
      const ids = String(ps.r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return ok({ dockerDown: false, stacks: [] });
      const ins = dockerCall(run, docker, ['inspect', ...ids], { deadlineAt, now });
      if (ins.down) return ok({ dockerDown: true, stacks: [] });
      if (!ins.fail) {
        out = String(ins.r.stdout ?? '');
        continue;
      }
      if (!ins.exited || ins.exited.timedOut || ins.exited.signal || !onlyNoSuchObject(ins.exited.stderr)) return ins.fail;
      let survivors = null;
      try {
        survivors = JSON.parse(String(ins.exited.stdout ?? ''));
      } catch {
        /* not usable: retry once below */
      }
      if (Array.isArray(survivors)) out = String(ins.exited.stdout);
      else if (attempt === 2) return ins.fail;
    }
    if (out === null) return unknown('docker inspect failed');
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      return unknown(`docker inspect output is not JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) return unknown('docker inspect output is not a list of containers');
    const byProject = new Map(); // lowercase id -> { project, list }
    for (const c of parsed) {
      const project = c?.Config?.Labels?.[PROJECT_LABEL];
      if (typeof project !== 'string' || project === '') continue;
      const key = project.toLowerCase();
      if (!byProject.has(key)) byProject.set(key, { project, list: [] });
      byProject.get(key).list.push(c);
    }
    const stacks = [...byProject.values()]
      .map(({ project, list }) => buildStack(project, list, { cfg, realpath }))
      .sort((a, b) => (a.project.toLowerCase() < b.project.toLowerCase() ? -1 : a.project.toLowerCase() > b.project.toLowerCase() ? 1 : 0));
    return ok({ dockerDown: false, stacks });
  } catch (err) {
    return unknown(`inventory failed: ${err?.message ?? err}`);
  }
}

// ---- 60 s cache: { writtenAt: <epoch ms>, inventory: { dockerDown, stacks } } ----
const validInventory = (v) => v && typeof v === 'object' && typeof v.dockerDown === 'boolean' && Array.isArray(v.stacks);

// { inv, fresh }: inv is the cached inventory value (or null when there is no usable cache), fresh says it is younger than
// maxAgeMs. A stale cache is still returned; this never refreshes (callers decide, via refreshCache). A cache dated in
// the future (clock moved back) is never fresh.
export function cachedInventory({ file, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { inv: null, fresh: false };
  }
  if (!j || !Number.isFinite(j.writtenAt) || !validInventory(j.inventory)) return { inv: null, fresh: false };
  const age = now - j.writtenAt;
  return { inv: j.inventory, fresh: age >= 0 && age < maxAgeMs };
}

// Runs `refresh()` (a readInventory result) and, when it is ok, replaces the cache atomically. An unknown refresh leaves
// the old cache alone; a cache that cannot be written is not an error. Returns the refresh result.
export function refreshCache({ file, refresh, now = Date.now() } = {}) {
  const result = refresh();
  if (!result?.ok) return result;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ writtenAt: now, inventory: result.value }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best effort: the next caller just refreshes again */
  }
  return result;
}
