// Review state: one JSON document that survives restarts (.review/state.json) and can be rebuilt
// from the PR's triage comment when the local copy is gone. The only IO in this module is
// loadState/saveState; everything else is pure.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const STATE_MARKER = /<!-- claude-pipeline:state:([A-Za-z0-9+/=]+) -->/g;
// A PR comment is at most 64 KiB, so real state is tiny; cap decompression so a hostile comment
// cannot make resume allocate gigabytes.
const MAX_DECODED_BYTES = 8 * 1024 * 1024;

export function emptyState({ repo, pr, branch, risk, lightLane = false, maxRounds = 3 }) {
  return {
    version: 1,
    repo,
    pr,
    branch,
    risk: risk ?? null,
    lightLane: lightLane === true,
    maxRounds,
    currentContentHash: '',
    rounds: [],
  };
}

const stateFile = (dir) => join(dir, '.review', 'state.json');

export function loadState(dir) {
  const file = stateFile(dir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // Not null: a caller that treats "no state" as "start fresh" would silently overwrite real history.
    throw new Error(`corrupt review state at ${file}: ${err.message}`);
  }
}

// Write a sibling tmp file, fsync it, then rename over the target: readers see the old or the
// new state, never half of one, and a crash mid-write leaves the old state intact.
export function saveState(dir, state) {
  const reviewDir = join(dir, '.review');
  mkdirSync(reviewDir, { recursive: true });
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const data = `${JSON.stringify(state, null, 2)}\n`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// base64 never contains "--", so the payload cannot terminate the HTML comment early.
export function encodeForComment(state) {
  return `<!-- claude-pipeline:state:${gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')} -->`;
}

// Bad data of any kind yields null, never an exception: resume must fall back to a fresh review,
// not crash on someone's edited comment. The LAST marker wins so that quoted or forged markers
// earlier in a body cannot override the real one the pipeline writes at the end.
export function decodeFromComment(body) {
  if (typeof body !== 'string') return null;
  const matches = [...body.matchAll(STATE_MARKER)];
  if (matches.length === 0) return null;
  try {
    const raw = gunzipSync(Buffer.from(matches.at(-1)[1], 'base64'), { maxOutputLength: MAX_DECODED_BYTES });
    const state = JSON.parse(raw.toString('utf8'));
    return state !== null && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

export function addRound(state, { n, fromHead, toHead, contentHashAtToHead, items }) {
  if (state.rounds.some((r) => r.n === n)) throw new Error(`round ${n} already exists in the review state`);
  return {
    ...state,
    rounds: [...state.rounds, { n, fromHead, toHead, contentHashAtToHead, items: structuredClone(items) }],
  };
}

// Replace items of round n by id and keep the rest, so a caller can pass either the whole
// updated list or just the items it changed. Unknown ids are appended.
export function updateItems(state, n, items) {
  const at = state.rounds.findIndex((r) => r.n === n);
  if (at < 0) throw new Error(`round ${n} not found in the review state`);
  const merged = state.rounds[at].items.map((existing) => {
    const update = items.find((i) => i.id === existing.id);
    return update ? structuredClone(update) : existing;
  });
  const known = new Set(merged.map((i) => i.id));
  for (const item of items) {
    if (!known.has(item.id)) {
      known.add(item.id);
      merged.push(structuredClone(item));
    }
  }
  const rounds = state.rounds.map((r, i) => (i === at ? { ...r, items: merged } : r));
  return { ...state, rounds };
}
