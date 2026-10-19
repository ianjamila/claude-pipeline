// Machine config, modes, keep list and pause file for stack-stop. Everything here fails closed: a missing or broken
// config makes the feature inert, a broken mode file means `report`, an unreadable keep list is `unknown`, an unreadable
// pause location counts as paused. Nothing in this file ever writes the machine config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, toPosix } from '../paths.mjs';
import { ok, unknown } from './result.mjs';

const BUILT_IN_SHARED_SUFFIX = '-pipeline';
const BUILT_IN_SHARED_WORKDIR = '/.verify/supabase-workdir';
const DEFAULT_DEV_PORTS = [3000, 4000, 4017];

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
const ports = (v) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535);

function invalid(error) {
  return { status: 'invalid', error, shared: new Set(), repos: [], memoryDirs: [], memoryExclude: [], transcriptDirs: [], devPorts: [] };
}

// <root>/config.json. `memoryExclude` entries are file names (not paths); the path lists get `~` expanded against `home`.
export function loadMachineConfig(file, { home = os.homedir() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...invalid(undefined), status: 'missing', error: undefined };
    return invalid(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    return invalid(`not valid JSON: ${err.message}`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return invalid('top level must be an object');
  const list = (key) => {
    if (j[key] === undefined) return [];
    if (!strings(j[key])) throw new Error(`${key} must be an array of non-empty strings`);
    return j[key];
  };
  try {
    const exp = (a) => a.map((p) => expandHome(p, home));
    const transcriptDirs = j.transcriptDirs === undefined ? [path.join(home, '.claude*', 'projects')] : exp(list('transcriptDirs'));
    if (j.devPorts !== undefined && !ports(j.devPorts)) throw new Error('devPorts must be an array of ports 1-65535');
    return {
      status: 'ok',
      shared: new Set(list('shared').map((s) => s.trim().toLowerCase())),
      repos: exp(list('repos')),
      memoryDirs: exp(list('memoryDirs')),
      memoryExclude: list('memoryExclude'),
      transcriptDirs,
      devPorts: j.devPorts === undefined ? [...DEFAULT_DEV_PORTS] : [...j.devPorts],
    };
  } catch (err) {
    return invalid(err.message);
  }
}

// Shared stacks are never stopped. The two built-in rules hold even when no config could be loaded.
export function isShared({ project, workdir } = {}, cfg) {
  const id = String(project ?? '').toLowerCase();
  if (id && cfg?.shared?.has(id)) return true;
  if (id.endsWith(BUILT_IN_SHARED_SUFFIX)) return true;
  if (workdir && toPosix(workdir).toLowerCase().includes(BUILT_IN_SHARED_WORKDIR)) return true;
  return false;
}

const MODE_KEYS = ['sessionEnd', 'sweeper', 'devServers'];
const MODE_VALUES = new Set(['report', 'apply']);
const allReport = () => ({ sessionEnd: 'report', sweeper: 'report', devServers: 'report' });

// Missing, unreadable or invalid (per key) => `report`. Only the exact string `apply` switches stopping on.
export function loadModes(file) {
  const modes = allReport();
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return modes;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return modes;
  for (const key of MODE_KEYS) if (MODE_VALUES.has(j[key])) modes[key] = j[key];
  return modes;
}

// Creates the all-`report` file only when it is absent; never touches an existing one (the owner's switches are theirs).
export function ensureModeFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(allReport(), null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// One project id per line; `#` starts a comment; ids compare lowercase. Missing file = nobody is kept; anything else that
// cannot be read is unknown (the caller then keeps everything).
export function loadKeep(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return ok(new Set());
    return unknown(`cannot read keep list ${file}: ${err.code ?? err.message}`);
  }
  const ids = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trim().toLowerCase()).filter(Boolean);
  return ok(new Set(ids));
}

// The pause file is a plain existence test. A location that cannot be checked counts as paused: no stop on doubt.
export function isPaused(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT' && err.code !== 'ENOTDIR';
  }
}
