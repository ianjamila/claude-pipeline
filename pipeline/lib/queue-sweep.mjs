// The renewable observer of queue mode: carries every live merge-queue record to its end, whoever is (or is not) running a `P merge`.
// `sweepRepo` runs lib/merge-queue.mjs settleRecord over the live records of ONE repo (per record, under the same per-repo-and-PR merge lock a
// `P merge` of that PR takes, so a running merge is never raced: Fable F1). `sweepAll` does it for one repo or for every repo the machine knows.
// A record with nothing live is found by reading a directory: no GitHub call at all.
// Re-queueing is the one thing here that is not a plain settle, and it only ever happens from the worktree the owner approved (Fable F11).
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { headSha } from './git.mjs';
import { createGitHub } from './github.mjs';
import { withMergeLock } from './hold.mjs';
import { defaultLockDir } from './locks.mjs';
import { liveRecords, recordIsFor, recordedHold, settleRecord } from './merge-queue.mjs';
import { canon, createQueueRoute, isDir, recheckGatedRecorded, recheckOwnerGo, recordedWorktreeProblem, restoreHoldOnTerminal } from './queue-route.mjs';
import { gitCommonDir } from './repo.mjs';
import { loadMachineConfig } from './stacks/config.mjs';
import { stackFiles, stacksRoot } from './stacks/paths.mjs';
import { pruneLogDir } from './worktree-prune/run.mjs';

const msg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);
const refuse = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, merged: false, error, reasons, ...extra } });

// ---- the owner is told about each terminal outcome ---------------------------------------------------------------------------------
// There is no other notification path in this pipeline, so a notice is: a line on stderr (a `P merge` session sees it; the LaunchAgent's log keeps it), a line in
// <log dir>/queue-sweep-notices.log, and on macOS a banner. A failing notifier never undoes a settled record (settleRecord swallows it).
const appleText = (text) => String(text).replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240);

// `event` names another kind of notice that uses the same three channels (`pipeline-update`: the auto-update job): its own stderr prefix,
// log file (<event>-notices.log) and banner title, so it is not mistaken for a merge-queue notice. The default is the queue sweep's.
export function defaultNotify({ env = process.env, platform = process.platform, stderr = process.stderr, spawn = spawnSync, event = 'queue-sweep' } = {}) {
  const title = event === 'queue-sweep' ? 'claude-pipeline merge queue' : `claude-pipeline ${event.replace(/^pipeline-/, '')}`;
  return (text) => {
    stderr.write(`${event}: ${text}\n`);
    try {
      const dir = pruneLogDir(env);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, `${event}-notices.log`), `${new Date().toISOString()} ${String(text).replace(/\s+/g, ' ')}\n`);
    } catch { /* the stderr line is the notice that matters */ }
    if (platform === 'darwin' && env.PIPELINE_NO_BANNER !== '1') {
      try {
        spawn('/usr/bin/osascript', ['-e', `display notification "${appleText(text)}" with title "${title}"`], { timeout: 5000, stdio: 'ignore' });
      } catch { /* no banner is not a failure */ }
    }
  };
}

// ---- the repos the machine knows ----------------------------------------------------------------------------------------------------------
// The repos the stacks sweep lists (its machine config) plus the ones `P merge` / `P final-gate` / `P queue-sweep --repo` told this file about.
// The list sits in the merge lock directory (PIPELINE_LOCK_DIR moves it, so a test run never writes the real one): machine state, like the locks.
const registryFile = (env) => path.join(env?.PIPELINE_LOCK_DIR || defaultLockDir(), 'queue-sweep-repos.json');
const REGISTRY_MAX = 100;

// `onError(text)` (optional) hears about a registry that EXISTS but cannot be read or parsed; an absent one is normal. The result is [] either way.
function readRegistry(env, onError) {
  try {
    const j = JSON.parse(readFileSync(registryFile(env), 'utf8'));
    return Array.isArray(j?.repos) ? j.repos.filter((r) => typeof r === 'string' && r !== '') : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') onError?.(`the repository registry ${registryFile(env)} cannot be read: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`);
    return [];
  }
}

// The checkout that outlives its worktrees: the parent of the common .git dir (or the root itself in a bare-style layout).
const stableRoot = (root) => {
  const common = gitCommonDir(root);
  return path.basename(common) === '.git' ? path.dirname(common) : root;
};

// Remember `root` (best effort; a registry that cannot be written only means the LaunchAgent will not see this repo until a merge names it again).
export function registerRepo({ root, env = process.env }) {
  try {
    const keep = stableRoot(root);
    const list = readRegistry(env);
    if (list.includes(keep)) return false;
    const file = registryFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ repos: [...list, keep].slice(-REGISTRY_MAX) }, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// `onError(text)` (optional, for the live-work scan, which must not read "could not look" as "nothing there"): called for a stacks config or a registry
// that exists but cannot be parsed, and for a directory that exists where git fails for any reason but "not a git repository". The returned list is the same with or without it.
export function knownRepos({ home = os.homedir(), env = process.env, onError } = {}) {
  const found = [];
  try {
    const cfg = loadMachineConfig(stackFiles(stacksRoot(env, home)).config, { home });
    if (cfg.status === 'ok') found.push(...cfg.repos);
    else if (cfg.status === 'invalid') onError?.(`the stacks config cannot be read: ${cfg.error}`);
  } catch { /* no stacks config: only the registry */ }
  found.push(...readRegistry(env, onError));
  const seen = new Set();
  const out = [];
  for (const dir of found) {
    if (!isDir(dir)) continue;
    let key;
    try {
      key = canon(gitCommonDir(dir)); // canon is realpath.native: the on-disk spelling (short names expanded), so one repository reached two ways gets one key
    } catch (err) {
      // not a git repository (any more): skipped silently. Any other failure (dubious ownership, a corrupt repository, git killed or timed out) means
      // this repository was NOT looked at, which the live-work scan must not read as "nothing running there".
      if (!(err?.code === 128 && !err?.abnormal && /not a git repository/i.test(String(err?.stderr ?? '')))) onError?.(`cannot tell whether ${dir} is a git repository (git rev-parse --git-common-dir): ${msg(err)}`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// ---- the re-queue, from a live worktree only (Fable F11) ------------------------------------------------------------------------------------
// -> the `requeue` function settleRecord takes. ok:false ends the record `removed` (or `blocked`), puts an owned hold back and notifies;
// { ok:false, unsettled:true } (the enqueue could not be confirmed) leaves the record as it is.
// The re-queue is judged the way the route that opened the record judged the first enqueue (#229): a `gated` record by the gated recheck,
// an `owner-go` one by the owner-go recheck. A record without a route (written before it was recorded) is owner-go: the stricter reading, fail closed.
export function makeRequeue({ gh, root, env, say, now, sleep, log, loadCfg = loadConfig, headOf = (cwd) => headSha({ cwd }), recheckFn = recheckOwnerGo, recheckGatedFn = recheckGatedRecorded }) {
  return async ({ rec }) => {
    const pr = rec.pr;
    const stop = (why) => ({ ok: false, reasons: [`${why} — re-run \`P merge --pr ${pr}\` to re-queue`] });
    const problem = recordedWorktreeProblem({ rec, root, headOf });
    if (problem !== null) return stop(problem);
    const loaded = await loadCfg(rec.root);
    if (!loaded?.ok) return { ok: false, reasons: [`the pipeline config of ${rec.root} is not usable, so the re-queue was not checked`] };
    const config = loaded.config;
    const hold = recordedHold(rec);
    const recheck = () => (rec.route === 'gated'
      ? recheckGatedFn({ root: rec.root, config, pr, gh, env, head: rec.head, repo: gh.repo().slug, rec })
      : recheckFn({ root: rec.root, config, pr, gh, env, head: rec.head, repo: gh.repo().slug, hold }));
    const again = await recheck();
    if (!again.ok) return { ok: false, ...(again.error === 'blocked' ? { kind: 'blocked' } : {}), reasons: again.reasons };
    const route = createQueueRoute({
      gh, root: rec.root, config, pr, head: rec.head, route: rec.route ?? null, env, refuse, approval: rec.approval, recheck,
      onTerminal: restoreHoldOnTerminal({ gh, pr }), now, sleep, log,
    });
    const out = await route.reenqueue();
    if (out.ok) return { ok: true };
    if (out.done?.output?.merged === true) {
      say(`PR #${pr} merged through the merge queue`);
      return { ok: true };
    }
    // queue-unreadable: the enqueue may have landed. Not a rejection (that would restore the hold and end the record over a live entry).
    if (out.done?.output?.error === 'queue-unreadable') return { ok: false, unsettled: true, reasons: out.done.output.reasons ?? ['the re-queue could not be confirmed'] };
    return { ok: false, reasons: out.done?.output?.reasons ?? ['the re-queue did not go through'] };
  };
}

// ---- one repo -------------------------------------------------------------------------------------------------------------------------------------------
// Options: `requeue: false` settles only (P final-gate's best-effort sweep never enqueues); `exceptPr` leaves one PR alone (the PR a `P merge` is about to handle itself).
// -> { root, settled: [{ pr, outcome, ... }], skipped: [{ pr, why }], errors: [text] }. Never throws.
export async function sweepRepo({
  root, env = process.env, requeue = true, exceptPr = null, notify = null, makeGh = (r) => createGitHub({ cwd: r, env }), now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, log = () => {}, alive, loadCfg, headOf, recheckFn, recheckGatedFn,
}) {
  const out = { root, settled: [], skipped: [], errors: [] };
  let records;
  try {
    records = liveRecords(root, { onError: (err) => out.errors.push(msg(err)) }).filter((r) => r.pr !== exceptPr);
  } catch (err) {
    out.errors.push(msg(err));
    return out;
  }
  if (records.length === 0) return out; // nothing live: no GitHub call
  const say = (text) => { try { notify?.(text); } catch { /* a notification failure must not undo a settled record */ } };
  let gh;
  let ident;
  try {
    gh = makeGh(root);
    ident = { repo: gh.repo().slug, repoId: typeof gh.repoId === 'function' ? gh.repoId() : null };
  } catch (err) {
    out.errors.push(`could not read the GitHub repository of ${root} (${msg(err)})`);
    return out;
  }
  for (const rec of records) {
    try {
      if (!recordIsFor(rec, ident)) {
        out.skipped.push({ pr: rec.pr, why: `the record belongs to ${rec.repo}, not ${ident.repo}` });
        continue;
      }
      const res = await withMergeLock({
        gh, pr: rec.pr, env, ...(alive ? { alive } : {}),
        refuse: (error) => ({ busy: true, error }),
        fn: () => settleRecord({
          gh, root, pr: rec.pr, now, sleep, pollMs, log, notify: say,
          requeue: requeue ? makeRequeue({ gh, root, env, say, now, sleep, log, ...(loadCfg ? { loadCfg } : {}), ...(headOf ? { headOf } : {}), ...(recheckFn ? { recheckFn } : {}), ...(recheckGatedFn ? { recheckGatedFn } : {}) }) : null,
        }),
      });
      if (res.busy) {
        out.skipped.push({ pr: rec.pr, why: 'a `P merge` for this PR is running (merge-in-progress)' });
        continue;
      }
      const { outcome, terminal, hold, position, message, why, removal } = res;
      out.settled.push({
        pr: rec.pr, outcome,
        ...(terminal ? { terminal } : {}), ...(hold ? { hold } : {}), ...(position !== undefined && position !== null ? { position } : {}),
        ...(removal?.reason ? { removalReason: removal.reason } : {}), ...(message ? { message } : {}), ...(why ? { why } : {}),
      });
    } catch (err) {
      out.settled.push({ pr: rec.pr, outcome: 'error', why: msg(err) });
    }
  }
  return out;
}

// ---- one repo or all of them ----------------------------------------------------------------------------------------------------------------------
// `repo` (a root) sweeps that repo only and remembers it; null sweeps every known repo.
export async function sweepAll({ repo = null, env = process.env, home = os.homedir(), ...rest }) {
  let roots;
  if (repo !== null) {
    registerRepo({ root: repo, env });
    roots = [repo];
  } else {
    roots = knownRepos({ home, env });
  }
  const repos = [];
  for (const root of roots) repos.push(await sweepRepo({ root, env, ...rest }));
  return { repos };
}

// What `P merge` and `P final-gate` do first: settle the repo's live records. Best effort: any failure is logged, never thrown, never changes the caller's result.
export async function bestEffortSweep({ root, requeue, exceptPr = null, env = process.env, home = os.homedir(), warn = (t) => process.stderr.write(`${t}\n`), ...rest }) {
  try {
    const res = await sweepAll({ repo: root, env, home, requeue, exceptPr, notify: rest.notify ?? defaultNotify({ env }), ...rest });
    for (const r of res.repos) for (const e of r.errors) warn(`queue-sweep: ${e}`);
    return res;
  } catch (err) {
    warn(`queue-sweep: ${msg(err)}`);
    return { repos: [] };
  }
}
