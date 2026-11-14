// Plumbing shared by the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// Why one module: they all read and write the same .review/ tree and must agree on what "the content that was
// reviewed" means. In particular `currentContentHash` is the single definition of the hash that round coverage and
// the merge gate compare, so a command that hashed differently would let a stale review look current. (The formula itself lives in git.mjs.)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { Fail } from './cmd-common.mjs';
import { GitError, NETWORK_TIMEOUT_MS, git, reviewBaseRef as gitReviewBaseRef, reviewContentHash } from './git.mjs';
import { LockTimeoutError, withLock } from './locks.mjs';
import { parseRemote } from './remote-url.mjs';
import { hashBranch, trustedDefaultBranch } from './risk.mjs';
import { loadState } from './state.mjs';

export const EXCERPT_RADIUS = 20;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- content hash ---------------------------------------------------------------------------

// `origin/<branch>` is what the PR will be merged into (the default branch unless the PR names its own base); see
// git.mjs#reviewBaseRef for the fallback.
export const reviewBaseRef = (root, config, branch = hashBranch(root, config)) => gitReviewBaseRef(branch, { cwd: root });

// Best-effort refresh of origin/<trusted default branch> (GitHub's default), for the commands that hash the content WITHOUT having fetched (review-complete,
// state outcome, state mark-implemented; codex-review fetches on its own). The hash is the PR's diff against merge-base(origin/<branch>,
// HEAD): after `update-branch` + `git pull --ff-only` (which fetches the PR branch only) the local origin/<branch> is older than the
// main that was merged in, so the merge base is older, the diff includes main's new commits and the hash differs from the round's.
// Offline, no remote or a slow one (GitError, timeouts included) keeps the cached ref, as codex-review does: { refreshed: false, reason }.
// usesRemoteRef: the hash is measured from origin/<branch> (it exists, fetched now or left over), not from the local <branch>. A caller
// that must not trust a stale ref (mark-implemented) refuses when usesRemoteRef && !refreshed. Anything but a GitError is a bug and throws.
export function refreshBaseRef(root, config) {
  const branch = hashBranch(root, config); // the trusted default branch (risk.mjs#trustedDefaultBranch), the one the hash is measured from; `refreshed` says THAT fetch worked
  let refreshed = false;
  let reason;
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
    refreshed = true;
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    reason = String(err.message).split('\n')[0].slice(0, 200);
  }
  const usesRemoteRef = reviewBaseRef(root, config, branch) === `refs/remotes/origin/${branch}`;
  return { refreshed, ...(reason === undefined ? {} : { reason }), usesRemoteRef };
}

// Best-effort refresh of origin/<TRUSTED default branch> (risk.mjs#trustedDefaultBranch: what the remote calls its default, never the working-tree config's value), for the readers of the
// trusted fork point = mergeBase(origin/<that>, head), which picks the Codex model, the effort lanes and the substitute gates (admitRound, review-complete, triage second-review): a local
// ref behind the remote would name an older config. `except`: a branch the caller already fetched. A clone with no origin remote or an anchor only the working tree gives has nothing to
// fetch; a failed fetch is not an error (the cached ref is used). -> true when it was fetched now.
export function refreshTrustedDefault(root, config, { except } = {}) {
  const { branch, anchor, untrusted } = trustedDefaultBranch(root, config);
  if (anchor === 'config' || untrusted !== null || branch === except) return false;
  try {
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
    return true;
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return false;
  }
}

// What the branch changes relative to where it forked, minus the agent log. One definition, in git.mjs, shared with the
// final gate (finalgate.mjs#localContentHash).
export const currentContentHash = (root, config, branch = hashBranch(root, config)) =>
  reviewContentHash({ branch, agentLog: config.agent_log }, { cwd: root });

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
// sessions (a review run and a person with a terminal, two review runs on one PR) cannot lose each other's update.
// One lock per repository and PR: every worktree and clone of one repo on this machine shares it (the key is the normalized origin remote, see
// repoLockKey), so a decision written in one checkout cannot interleave with a publication or a merge from another. The lock directory is ~/.claude/pipeline-state/locks unless
// PIPELINE_LOCK_DIR says otherwise (tests); PIPELINE_LOCK_WAIT_MS shortens the wait (tests).
export const LOCK_WAIT_MS = 2 * 60 * 1000;

// What identifies the repository, not the checkout: the origin remote as host/owner/name, lower-cased (https, ssh and scp forms of one
// remote agree); with no usable origin, the absolute git common dir (shared by the worktrees of one repo); outside a git repo, the root
// itself. Never throws. Memoized per root for the life of the process.
const lockKeys = new Map();
export function repoLockKey(root) {
  if (lockKeys.has(root)) return lockKeys.get(root);
  let key = root;
  try {
    let remote = null;
    try {
      remote = parseRemote(git(['config', '--get', 'remote.origin.url'], { cwd: root }).trim());
    } catch { /* no origin */ }
    if (remote) {
      key = `remote:${remote.host}/${remote.owner}/${remote.name}`.toLowerCase();
    } else {
      const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], { cwd: root }).trim());
      try {
        key = `git:${realpathSync(common)}`;
      } catch {
        key = `git:${common}`;
      }
    }
  } catch { /* not a git repository: the root itself */ }
  lockKeys.set(root, key);
  return key;
}

export const reviewLockName = (root, pr) => `review-${sha256(repoLockKey(root)).slice(0, 12)}-pr${pr}`;

async function withNamedReviewLock(name, defaultWaitMs, ctx, fn) {
  const env = ctx?.env ?? process.env;
  const wait = Number(env.PIPELINE_LOCK_WAIT_MS);
  try {
    return await withLock(name, fn, { dir: env.PIPELINE_LOCK_DIR || undefined, waitMs: wait > 0 ? wait : defaultWaitMs });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new Fail(EXIT.USAGE, { ok: false, error: 'lock-timeout', message: err.message });
    throw err;
  }
}

export const withReviewLock = (root, pr, ctx, fn) => withNamedReviewLock(reviewLockName(root, pr), LOCK_WAIT_MS, ctx, fn);

// The route lock (per PR) guards route.json's compare-and-swap: a pending record is installed under it ALONE, so a held review lock (Codex's recording of another round,
// a substitute's apply) never stops a codex-review attempt from starting, and every final write of route.json (compare + write) holds it so a pending record cannot land
// between them (R1-B2). Lock order is always review -> route; the pending write takes no review lock, so the two cannot deadlock. Its sections are short: a short wait.
export const ROUTE_LOCK_WAIT_MS = 15 * 1000;
export const routeLockName = (root, pr) => `${reviewLockName(root, pr)}-route`;
export const withRouteLock = (root, pr, ctx, fn) => withNamedReviewLock(routeLockName(root, pr), ROUTE_LOCK_WAIT_MS, ctx, fn);

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
export function canonicalJson(value) {
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
    secondReview: i.secondReview, test: i.test,
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

// ---- published history (rounds and owner grants) ---------------------------------------------

// A round's identity: what makes it THE round n of this review (the decisions on its items may still change). Grant metadata on it
// (`ownerGrant`) is add-only history: a grant the PR already holds is never dropped or altered.
const sameRound = (a, b) => a.toHead === b.toHead && a.contentHashAtToHead === b.contentHashAtToHead;
const sameGrant = (a, b) => canonicalJson(a.ownerGrant ?? null) === canonicalJson(b.ownerGrant ?? null);

/**
 * Round-by-round difference between a LOCAL review state and the PUBLISHED one, read-only. Every field is a sorted list of round numbers:
 *   missing        published rounds the local state has no round n for
 *   changed        published rounds whose local round n has another toHead or contentHashAtToHead (another round wearing the number)
 *   grantsBehind   identity-equal rounds where the PR holds an `ownerGrant` the local round lacks
 *   grantsDiffer   identity-equal rounds where both hold an `ownerGrant` and they are not equal
 *   extra          local rounds the PR does not hold (an unpublished trailing round, or a gap)
 *   grantsAhead    identity-equal rounds where only the local round holds an `ownerGrant`
 */
export function historyDiff(local, published) {
  const mine = new Map((local?.rounds ?? []).map((r) => [r.n, r]));
  const theirs = new Map((published?.rounds ?? []).map((r) => [r.n, r]));
  const d = { missing: [], changed: [], grantsBehind: [], grantsDiffer: [], extra: [], grantsAhead: [] };
  for (const [n, p] of theirs) {
    const r = mine.get(n);
    if (r === undefined) d.missing.push(n);
    else if (!sameRound(r, p)) d.changed.push(n);
    else if (!sameGrant(r, p)) {
      if (p.ownerGrant === undefined) d.grantsAhead.push(n);
      else if (r.ownerGrant === undefined) d.grantsBehind.push(n);
      else d.grantsDiffer.push(n);
    }
  }
  for (const n of mine.keys()) if (!theirs.has(n)) d.extra.push(n);
  for (const list of Object.values(d)) list.sort((a, b) => a - b);
  return d;
}

/**
 * Would replacing the published state with `local` lose published history? -> { ok, lostRounds:[n], lostGrants:[n] } (always an object: test `.ok`).
 * ok when every published round is present locally with the same (n, toHead, contentHashAtToHead) and every published `ownerGrant` is equal
 * on the local round. Item decisions may differ (that is what a publication is for); extra local rounds and grants are fine.
 */
export function historyPreserved(local, published) {
  const d = historyDiff(local, published);
  const lostRounds = [...d.missing, ...d.changed].sort((a, b) => a - b);
  const lostGrants = [...d.grantsBehind, ...d.grantsDiffer].sort((a, b) => a - b);
  return { ok: lostRounds.length === 0 && lostGrants.length === 0, lostRounds, lostGrants };
}

/**
 * How the local review state relates to the published one, as history only (decisions are not compared). Read-only.
 *   'in-sync'      the same rounds and the same grant metadata
 *   'local-ahead'  local strictly extends the PR: whole trailing rounds the PR lacks and / or grants added on identity-equal rounds
 *   'local-behind' the PR holds rounds or grants the local state lacks
 *   'diverged'     both: each side has history the other lacks, or a round number or a grant is held by something different
 */
export function compareHistory(local, published) {
  const d = historyDiff(local, published);
  if (d.changed.length > 0 || d.grantsDiffer.length > 0) return 'diverged';
  const behind = d.missing.length > 0 || d.grantsBehind.length > 0;
  // A local round numbered below the newest published one is not a trailing round: the PR has a gap there, so neither side extends the other.
  const maxPublished = Math.max(0, ...(published?.rounds ?? []).map((r) => r.n));
  const ahead = d.grantsAhead.length > 0 || d.extra.length > 0;
  if (d.extra.some((n) => n < maxPublished)) return 'diverged';
  if (behind && ahead) return 'diverged';
  if (behind) return 'local-behind';
  return ahead ? 'local-ahead' : 'in-sync';
}

/**
 * The local state with the PR's owner grants copied onto the identity-equal rounds that lack them or hold another one (the grant and the admission that
 * goes with it). Nothing else changes: local decisions and local trailing rounds are kept. -> { state, restored:[n] } (state is the same object when
 * nothing was copied). Why: grants are add-only history, so a copy that is missing one takes it from the PR instead of being replaced by it.
 */
export function adoptPublishedGrants(local, published) {
  const theirs = new Map((published?.rounds ?? []).filter((p) => p.ownerGrant !== undefined).map((p) => [p.n, p]));
  const restored = [];
  const rounds = (local?.rounds ?? []).map((r) => {
    const p = theirs.get(r.n);
    if (p === undefined || !sameRound(r, p) || sameGrant(r, p)) return r;
    restored.push(r.n);
    return { ...r, ownerGrant: p.ownerGrant, ...(p.admission === undefined ? {} : { admission: p.admission }) };
  });
  return { state: restored.length === 0 ? local : { ...local, rounds }, restored: restored.sort((a, b) => a - b) };
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
