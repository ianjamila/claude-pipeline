// Plumbing shared by the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// Why one module: they all read and write the same .review/ tree and must agree on what "the content that was
// reviewed" means. In particular `currentContentHash` is the single definition of the hash that round coverage and
// the merge gate compare, so a command that hashed differently would let a stale review look current. (The formula itself lives in git.mjs.)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { reviewBaseRef as gitReviewBaseRef, reviewContentHash } from './git.mjs';
import { LockTimeoutError, withLock } from './locks.mjs';
import { loadState } from './state.mjs';

export const EXCERPT_RADIUS = 20;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- content hash ---------------------------------------------------------------------------

// `origin/<branch>` is what the PR will be merged into (the default branch unless the PR names its own base); see
// git.mjs#reviewBaseRef for the fallback.
export const reviewBaseRef = (root, config, branch = config.default_branch) => gitReviewBaseRef(branch, { cwd: root });

// What the branch changes relative to where it forked, minus the agent log. One definition, in git.mjs, shared with the
// final gate (finalgate.mjs#localContentHash).
export const currentContentHash = (root, config) =>
  reviewContentHash({ branch: config.default_branch, agentLog: config.agent_log }, { cwd: root });

// ---- .review/ layout ------------------------------------------------------------------------

export const reviewDir = (root) => path.join(root, '.review');
export const roundDir = (root, n) => path.join(reviewDir(root), `round-${n}`);

export function ensureRoundDir(root, n) {
  const dir = roundDir(root, n);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Write-then-rename so a reader (or a crash) never sees half a file.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const writeJson = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function readFileOrFail(file, what) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'read', message: `cannot read ${what} ${file}: ${err.code ?? err.message}` });
  }
}

// ---- locking --------------------------------------------------------------------------------

// Every command that reads-modifies-writes .review/state.json holds this lock for the whole read-modify-write, so two
// sessions (a ship loop and a person with a terminal, two ship loops on one PR) cannot lose each other's update.
// One lock per repository checkout and PR. The lock directory is ~/.claude/pipeline-state/locks unless
// PIPELINE_LOCK_DIR says otherwise (tests); PIPELINE_LOCK_WAIT_MS shortens the wait (tests).
export const LOCK_WAIT_MS = 2 * 60 * 1000;

export const reviewLockName = (root, pr) => `review-${sha256(root).slice(0, 12)}-pr${pr}`;

export async function withReviewLock(root, pr, ctx, fn) {
  const env = ctx?.env ?? process.env;
  const wait = Number(env.PIPELINE_LOCK_WAIT_MS);
  try {
    return await withLock(reviewLockName(root, pr), fn, { dir: env.PIPELINE_LOCK_DIR || undefined, waitMs: wait > 0 ? wait : LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new Fail(EXIT.USAGE, { ok: false, error: 'lock-timeout', message: err.message });
    throw err;
  }
}

// For commands that do not know the PR up front: the state on disk names it. No readable state means the command
// fails on its own (requireState) before it changes anything, so it runs unlocked rather than under a made-up name.
export function withStateLock(root, ctx, fn, pr) {
  let n = pr;
  if (n === undefined) {
    try {
      n = loadState(root)?.pr;
    } catch {
      n = undefined;
    }
  }
  return n === undefined ? fn() : withReviewLock(root, n, ctx, fn);
}

// ---- state access ---------------------------------------------------------------------------

// No state, or state that cannot be read, is an environment problem (exit 2), never "start fresh".
export function requireState(root) {
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.USAGE, { ok: false, error: 'state', message: err.message });
  }
  if (!state) {
    throw new Fail(EXIT.USAGE, {
      ok: false, error: 'no-state', message: `no review state at ${path.join(reviewDir(root), 'state.json')}`,
    });
  }
  return state;
}

export function findRound(state, n) {
  const round = (state.rounds ?? []).find((r) => r.n === n);
  if (!round) throw new Fail(EXIT.USAGE, { ok: false, error: 'no-round', message: `round ${n} is not in the review state` });
  return round;
}

export const allItems = (state) => (state.rounds ?? []).flatMap((r) => r.items ?? []);

// Ids look like R<round>-<letter><k>, so they are unique across rounds; the round is read from the owning round.
export function findItem(state, id) {
  for (const round of state.rounds ?? []) {
    const item = (round.items ?? []).find((i) => i.id === id);
    if (item) return { round, item };
  }
  throw new Fail(EXIT.USAGE, { ok: false, error: 'no-item', message: `no item ${id} in the review state` });
}

// New state with `patch` merged into round n (state.mjs only offers updateItems).
export function patchRound(state, n, patch) {
  return { ...state, rounds: state.rounds.map((r) => (r.n === n ? { ...r, ...patch } : r)) };
}

// ---- code excerpts --------------------------------------------------------------------------

// The window of a file around `line` (1-based, +/- radius). Line 0 means "not line-specific": the whole file, or its
// first `maxLines` lines for display. Returns lines with their numbers, or null when the file is empty.
export function excerptWindow(content, line, { radius = EXCERPT_RADIUS, maxLines = Infinity } = {}) {
  if (typeof content !== 'string') return null;
  const all = content.split(/\r?\n/);
  if (all.length > 0 && all.at(-1) === '') all.pop(); // the newline that ends the file is not a line
  if (all.length === 0) return null;
  let start = 1;
  let end = all.length;
  if (Number.isInteger(line) && line > 0) {
    start = Math.max(1, line - radius);
    end = Math.min(all.length, line + radius);
  } else {
    end = Math.min(end, maxLines);
  }
  if (start > end) return null; // a line number past the end of the file
  return { start, end, lines: all.slice(start - 1, end) };
}

// ---- review replay (published vs local state) -----------------------------------------------

// A follow-up that is ready to be filed (not waiting for a human) but has no issue yet: resume replays
// `followups create` from the published items before the gate.
export const followupsPending = (state) => allItems(state).some(
  (i) => i.final?.decision === 'FOLLOW-UP' && i.final.needsHuman !== true && !i.followupIssue,
);

// JSON with sorted keys and no undefined, so two copies of the same decision compare equal whatever order a writer
// emitted the keys in.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// The part of a round that records what was DECIDED: one definition, used to tell a local state that merely continues the
// published one from one that disagrees with it. Items are compared by id, in id order.
export function decidedItemsKey(round) {
  const items = (round.items ?? []).map((i) => canonicalJson({
    id: i.id, fingerprint: i.fingerprint, final: i.final, judge: i.judge, arbiter: i.arbiter, implemented: i.implemented, followupIssue: i.followupIssue,
  }));
  return items.sort().join('\n');
}

// True when `local` strictly extends `published`: every published round is present locally with the same n, toHead,
// contentHashAtToHead and decided items. Extra local rounds (an unpublished, maybe incomplete, trailing one) are fine.
export function stateExtends(local, published) {
  const mine = new Map((local.rounds ?? []).map((r) => [r.n, r]));
  return (published.rounds ?? []).every((p) => {
    const r = mine.get(p.n);
    return r !== undefined && r.toHead === p.toHead && r.contentHashAtToHead === p.contentHashAtToHead && decidedItemsKey(r) === decidedItemsKey(p);
  });
}

// ---- stale quarantine -----------------------------------------------------------------------

// `.review/stale-<UTC timestamp>/`, never deleted: it holds whatever the published state replaced or a discarded round.
export function newStaleDir(root, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let dir = path.join(reviewDir(root), `stale-${stamp}`);
  for (let k = 2; existsSync(dir); k += 1) dir = path.join(reviewDir(root), `stale-${stamp}-${k}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Move everything in .review/ except earlier stale dirs into a new stale dir. Returns its path.
export function quarantineReviewDir(root) {
  const dir = newStaleDir(root);
  for (const name of readdirSync(reviewDir(root))) {
    if (name.startsWith('stale-')) continue;
    renameSync(path.join(reviewDir(root), name), path.join(dir, name));
  }
  return dir;
}

// ---- model proofs ---------------------------------------------------------------------------

// One entry per round whose Fable model proof passed. The round in the state carries the summary (`arbiter apply` stores
// it so it travels in the triage comment); the .review/round-*/model-proof.json file is the fallback for a round whose
// state predates that or whose state was not recovered.
export function readModelProofs(root, state = null) {
  const byRound = new Map();
  for (const r of state?.rounds ?? []) {
    const p = r?.modelProof;
    if (p && typeof p === 'object') byRound.set(r.n, { transcript: p.transcript, models: p.models, ...(p.effort ? { effort: p.effort } : {}) });
  }
  const dir = reviewDir(root);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => /^round-\d+$/.test(n))) {
      const n = Number(name.slice(6));
      if (byRound.has(n)) continue;
      try {
        const p = JSON.parse(readFileSync(path.join(dir, name, 'model-proof.json'), 'utf8'));
        if (p?.ok !== true) continue;
        const efforts = p.efforts && typeof p.efforts === 'object' ? Object.keys(p.efforts).join(', ') : '';
        byRound.set(n, { transcript: p.transcript, models: p.models, ...(efforts ? { effort: efforts } : {}) });
      } catch { /* no proof for this round */ }
    }
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}
