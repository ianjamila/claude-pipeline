// The unattended run behind `pipeline update --scheduled` (the LaunchAgent / crontab job `update schedule --install` sets up; ported and
// adapted from the earlier auto-update-schedule branch). It decides one thing per run and says it in two places: the status file below
// (read by the SessionStart hook) and, only when the owner has to act or something was installed, one notification.
//
// What it does, in this order:
//   current and unmodified            -> nothing at all (silent, exit 0)
//   behind main                       -> download main, run its installer with --require-no-live-reviews and --expect-installed <sha>
//     installed                       -> notify "pipeline updated to <sha7> (<PR title>)"
//     deferred (a review is live)     -> exit 0, one log line naming what is live; retried every run. Deferred for more than 24 h
//                                        (wall clock, from the first deferral; a clock that jumps backwards starts the count again) -> ONE notice
//                                        naming the lease holders
//     installed copy changed meanwhile (an owner edit, a manual install: the installer's expect-installed-mismatch) -> nothing written;
//                                        judged again as if found that way
//     verify failed (the installer's own verification, or its --check after the install) -> ONE notice with the drift list; this main sha is not
//                                        retried. The hold ends only when the install reads clean AND a fresh --check of that sha passes (deps.verifyInstalled)
//   modified, incomplete (an interrupted install's partial manifest), ahead of main or diverged -> NEVER touched automatically: drift alone cannot
//                                        tell an interrupted install from an owner edit. Notice once per (reason, main sha) with the exact command
//   transient failure (GitHub unreachable, an install lock busy) -> a notice only on the 3rd run in a row; any good run ends the streak
//   any other failure                 -> a notice once per (reason, main sha)
//
// Rollout (PR B): the first install of this code is the owner's manual `pipeline update`. From then on every pipeline command is a fresh
// process running the installed code, so a command that loaded older modules cannot outlive an install, and the job needs no restart.
//
// STATUS FILE  <accountHome>/.claude/pipeline-state/update-status.json   (accountHome(): the passwd home, never $HOME). Written atomically
// (a private temp file, then rename) on every run; a write that fails never fails the run. Read by the SessionStart hook, which must stay
// read-only and silent on any error. Schema, version 1:
//   { version: 1,
//     state: 'current' | 'behind' | 'deferred-by-review' | 'blocked-modified' | 'failed',
//     checkedAt: ISO time of this run,
//     installedSha: full sha the installed copy records as its source, or null,
//     mainSha: full sha of upstream main, or null when it could not be resolved,
//     mainTitle?: subject of main's commit (the PR title), when known,
//     deferredSince?: ISO time of the first deferral of this streak,          (deferred-by-review only)
//     deferredBy?: [{ repo, pr, worktree, kind?, detail?, hint? }],  what is live  (deferred-by-review only; a live-review deferral; `hint` = the owner's instruction, whole)
//     deferReason?: 'deadline' | 'admission-busy', the installer's other deferrals, which are not a review (the scan overran its deadline;
//                   another update or a review start holds admission); `message` carries the installer's sentence. The 3rd run in a row notifies once.
//     reason?: short code: modified | incomplete | ahead | diverged | check-failed | fetch-failed | install-failed | upstream-unresolved ...
//     message?: one human sentence for `reason`,
//     command?: the exact command the owner runs by hand }                   (blocked-modified and failed)
// 'behind' = an update is available and not yet installed (written when the install starts, and after a changed-meanwhile run).
// A transient failure that is not yet worth a notice leaves the previous status in place (only checkedAt moves).
//
// The notice bookkeeping (which (reason, sha) was already told, the transient streak, the sha whose verify failed) is a second file next
// to it, update-auto-state.json: { notified: [key], transient: {reason, runs}, noRetry: {sha, reason, message}, deferNotified: ISO }.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { isClean } from './identity.mjs';
import { accountHome, samePath } from './paths.mjs';
import { BANNER_MAX, defaultNotify } from './queue-sweep.mjs';

export const STATUS_VERSION = 1;
export const STATUS_FILE = 'update-status.json';
export const STATE_FILE = 'update-auto-state.json';
export const TRANSIENT_RUNS = 3;
export const DEFER_NOTICE_MS = 24 * 60 * 60 * 1000;
export const NOTIFY_EVENT = 'pipeline-update';
const NETWORK_TIMEOUT_MS = 15000;
const LOCK_BUSY = /another install is running|install lock/i;
const STATES = new Set(['current', 'behind', 'deferred-by-review', 'blocked-modified', 'failed']);

export const pipelineStateDir = (home = accountHome()) => path.join(home, '.claude', 'pipeline-state');

const sha7 = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The command the owner pastes in their own terminal. The default home is spelled ~/.claude; another one is quoted and named.
export function ownerCommand(home, userHome = os.homedir()) {
  if (samePath(home, path.join(userHome, '.claude'))) return 'node ~/.claude/pipeline/bin/pipeline.mjs update';
  return `node ${shQuote(path.join(home, 'pipeline', 'bin', 'pipeline.mjs'))} update --claude-home ${shQuote(home)}`;
}

// `leases` the same way: a standard install has no `pipeline` executable, so the owner gets the node command of the configured install dir.
// `leases` reads the lease folder of the machine, so it takes no --claude-home.
export function leasesCommand(home, userHome = os.homedir()) {
  if (samePath(home, path.join(userHome, '.claude'))) return 'node ~/.claude/pipeline/bin/pipeline.mjs leases';
  return `node ${shQuote(path.join(home, 'pipeline', 'bin', 'pipeline.mjs'))} leases`;
}

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// Atomic; never throws (a file that cannot be written costs a repeated notice or a stale status line, not the update).
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    return false;
  }
}

// What the installer reported as live, in the status file's shape. An entry may name a repo / PR / worktree (a review lease, a live
// merge-queue record) or only say what it is (a job, a held lock).
const DETAIL_MAX = 200;
const flat = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
// A hint is an instruction to do something (delete a file, remove a folder): it travels as its own field, WHOLE or not at all (a cut path can name another real file),
// and never inside `detail`, which is capped. An older installer (before the field existed) put the job hint at the end of detail; that exact template moves into `hint`.
const HINT_MAX = 300;
const LEGACY_HINT = /: (remove \S+ in that worktree if it is stale)$/;
const oneLine = (v) => flat(v).slice(0, DETAIL_MAX);
export function normalizeLive(live) {
  return (Array.isArray(live) ? live : []).map((l) => {
    if (!l || typeof l !== 'object') return { repo: null, pr: null, worktree: null, what: String(l) };
    let detail = typeof l.detail === 'string' && l.detail.trim() ? flat(l.detail) : null;
    let hint = typeof l.hint === 'string' && l.hint.trim() ? flat(l.hint) : null;
    if (detail) {
      const legacy = LEGACY_HINT.exec(detail);
      if (legacy) { // the scan keeps the old text in detail for older readers; either way the instruction lives in `hint`
        detail = detail.slice(0, legacy.index);
        hint ??= legacy[1];
      }
    }
    if (hint && hint.length > HINT_MAX) hint = null;
    return {
      repo: l.repo ?? l.repoId ?? null, pr: l.pr ?? l.branch ?? null, worktree: l.worktree ?? null,
      ...(typeof l.kind === 'string' ? { kind: l.kind } : {}),
      ...(typeof l.what === 'string' ? { what: l.what } : {}),
      ...(detail ? { detail: oneLine(detail) } : {}),
      ...(hint ? { hint } : {}),
    };
  });
}

// Every blocker is a scan that could not look (a corrupt registry, an unlistable jobs folder, git failing): nothing is known to be running.
export const onlyScanErrors = (by) => by.length > 0 && by.every((b) => b.kind === 'scan-error');

const scanDetail = (by) => {
  const shown = by.slice(0, 3).map((b) => b.detail ?? b.repo ?? b.worktree ?? 'unknown cause').join('; ');
  return by.length > 3 ? `${shown}; and ${by.length - 3} more` : shown;
};

// The hints of what is live, each once, in order. describeLive never prints them: the notice adds them to its action (below).
export const hintsOf = (by) => [...new Set(by.map((b) => b.hint).filter((h) => typeof h === 'string' && h))];

// Where the notice sends the owner for the hints: `leases` lists review leases only (not unreadable JOB records, merge locks ...), so it is offered only when EVERY
// hint comes from a lease entry (a live lease or one that could not be judged). Any other hint leads to the status file, which lists all of them.
// -> { pointer, fallbacks }: fallbacks are the shortest wordings, tried in order when the pointer does not fit; the last one always holds the status file path.
const LEASE_KINDS = new Set(['lease', 'scan-error']);
export function recoveryPointer(by, { leases, statusPath }) {
  const leasesOnly = by.filter((b) => typeof b.hint === 'string' && b.hint).every((b) => LEASE_KINDS.has(b.kind));
  if (!leasesOnly) return { pointer: `see ${statusPath}`, fallbacks: [] };
  return { pointer: `run: ${leases} (or see ${statusPath})`, fallbacks: [`run: ${leases}`, `see ${statusPath}`] };
}

// A notice for the owner, composed by budget (R4-1): `head` and the ACTION are reserved first, the CAUSE gets what is left of BANNER_MAX (cut with an ellipsis, never inside the
// action, so an instruction is never half a path). -> { text, banner }: `text` (stderr and the notices log) is whole, with every hint; `banner` is the budgeted display text.
//   action     = { plain }                                           the wording when there is nothing to point at
//              | { lead, hintLead, hints, tail, pointer, fallbacks }  no hints: `<lead>, or <tail>`. Hints: the first of these that leaves MIN_CAUSE of cause room:
//                                                                    `<hintLead><every hint>. Or <tail>`, `<hintLead><every hint>.`, `<hintLead><pointer>. Or <tail>`, `<hintLead><pointer>.`
//                                                                    (the tail and the pointer's path are always in the log line); with no room even for that, the first of `fallbacks`
//                                                                    (shorter pointers, see recoveryPointer) that fits at all, else the last one.
const MIN_CAUSE = 40;
export function composeNotice({ head: head0, cause: cause0, action }) {
  const head = flat(head0);
  const cause = flat(cause0);
  const join = (c, a) => (c ? `${head} ${c}. ${a}` : `${head} ${a}`);
  const cut = (room) => (cause.length <= room ? cause : room >= 2 ? `${cause.slice(0, room - 1).trimEnd()}…` : '');
  const fit = (a) => join(cut(BANNER_MAX - head.length - 3 - a.length), a);
  if (action.plain !== undefined) return { text: join(cause, action.plain), banner: fit(action.plain) };
  const { lead, hintLead, hints, tail, pointer, fallbacks = [] } = action;
  if (!hints.length) return { text: join(cause, `${lead}, or ${tail}`), banner: fit(`${lead}, or ${tail}`) };
  const roomy = (a) => head.length + 3 + MIN_CAUSE + a.length <= BANNER_MAX;
  const all = hints.join('; ');
  const tiers = [`${hintLead}${all}. Or ${tail}`, `${hintLead}${all}.`, `${hintLead}${pointer}. Or ${tail}`, `${hintLead}${pointer}.`];
  const bare = [tiers[3], ...fallbacks.map((f) => `${hintLead}${f}.`)];
  const shown = tiers.find(roomy) ?? bare.find((a) => head.length + 3 + a.length <= BANNER_MAX) ?? bare.at(-1);
  return { text: join(cause, tiers[0]), banner: fit(shown) };
}

export function describeLive(by) {
  if (!by.length) return 'a review is live';
  // An entry with no PR (a job, a held state or merge lock) is only told apart by its detail, so that follows it.
  const named = (b) => [b.repo ?? b.what ?? b.kind ?? 'a review', b.pr != null ? `#${b.pr}` : null, b.worktree ? `(${b.worktree})` : null].filter(Boolean).join(' ');
  const one = (b) => (b.kind === 'scan-error' ? `could not check (${b.detail ?? b.repo ?? b.worktree ?? 'scan-error'})` : b.pr == null && b.detail ? `${named(b)}: ${b.detail}` : named(b));
  const shown = by.slice(0, 5).map(one).join('; ');
  return by.length > 5 ? `${shown}; and ${by.length - 5} more` : shown;
}

// One scheduled run. `deps` = { mainSha, installedIdentity, relate, performUpdate, verifyInstalled } from commands/update.mjs. `ctx.auto` overrides any of them and
// also { notify(text), now(), accountHome, statusFile, stateFile } (tests never fetch, install, notify or touch the real home).
// -> { exitCode, compact: true, silent?, output }. Exit 0 for every outcome the owner does not have to fix at once (current, updated,
// deferred, paused); 1 for a failure.
export async function runScheduled({ home, env, ctx = {}, say = () => {}, deps }) {
  const auto = { ...deps, now: () => new Date(), ...(ctx.auto ?? {}) };
  const stateDir = pipelineStateDir(auto.accountHome ?? accountHome());
  const statusPath = auto.statusFile ?? path.join(stateDir, STATUS_FILE);
  const statePath = auto.stateFile ?? path.join(stateDir, STATE_FILE);
  const notifier = auto.notify ?? defaultNotify({ env, event: NOTIFY_EVENT });
  const nowDate = auto.now();
  const checkedAt = nowDate.toISOString();
  const command = ownerCommand(home);
  const prev = readJson(statusPath);
  let state = readJson(statePath) ?? {};

  const persist = () => {
    if (Object.keys(state).length === 0) { try { fs.rmSync(statePath, { force: true }); } catch { /* best effort */ } } else writeJsonAtomic(statePath, state);
  };
  // installedSha / mainSha are always present (null when unknown); every other optional field is left out when empty.
  const writeStatus = ({ state: st, installedSha: i = null, mainSha: m = null, ...rest }) => {
    const optional = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null));
    writeJsonAtomic(statusPath, { version: STATUS_VERSION, state: st, checkedAt, installedSha: i, mainSha: m, ...optional });
  };
  const done = (exitCode, o, silent = false) => ({ exitCode, compact: true, ...(silent ? { silent: true } : {}), output: { mode: 'scheduled', home, ...o } });
  // A good run (nothing to do, or installed) ends every streak and forgets every notice, so the next failure tells the owner again.
  const clearState = () => { state = {}; persist(); };
  // Tell the owner once per key; a notify that throws is not marked told, so the next run tries again.
  const tell = async (key, text, opts) => {
    if (Array.isArray(state.notified) && state.notified.includes(key)) return { sent: false, reason: 'already-told' };
    try {
      await (opts ? notifier(text, opts) : notifier(text));
    } catch (err) {
      return { sent: false, reason: 'error', error: String(err?.message ?? err).slice(0, 200) };
    }
    state = { ...state, notified: [...(Array.isArray(state.notified) ? state.notified : []), key] };
    persist();
    return { sent: true };
  };

  let main = null;
  let installedSha = null;
  const ids = () => ({ installedSha, mainSha: main?.ok ? main.sha : null });

  // ---- outcomes ----
  const blockedFor = async (id, why) => {
    const incomplete = Boolean(id) && !id.complete;
    const reason = why ?? (incomplete ? 'incomplete' : 'modified');
    const message = {
      modified: id ? 'the installed pipeline has local changes (or records no source commit)' : 'nothing is installed there',
      incomplete: 'the installed pipeline is incomplete (an interrupted install?)',
      ahead: 'the installed pipeline is ahead of main',
      diverged: 'the installed pipeline has diverged from main',
    }[reason];
    say(`scheduled update paused (${reason}): ${message}`);
    delete state.transient;
    const told = await tell(`blocked:${reason}:${main.sha}`, `pipeline auto-update paused: ${message}, so it was left alone. To replace it with main ${sha7(main.sha)}, run in your own terminal: ${command}`);
    writeStatus({ state: 'blocked-modified', ...ids(), reason, message, command });
    persist();
    return done(EXIT.OK, { ok: true, action: 'blocked', reason, message, main: { sha: main.sha }, notify: told });
  };
  const failed = async (reason, message, { transient = false, noRetry = false, text = null, extra = {} } = {}) => {
    say(`scheduled update failed: ${message}`);
    const sha = main?.ok ? main.sha : 'unknown';
    if (transient) {
      const runs = (state.transient?.reason === reason ? Number(state.transient.runs) || 0 : 0) + 1;
      state = { ...state, transient: { reason, runs } };
      persist();
      if (runs < TRANSIENT_RUNS) {
        // Not worth a notice yet: the status the owner sees stays what it was.
        if (prev && STATES.has(prev.state)) writeJsonAtomic(statusPath, { ...prev, checkedAt });
        else writeStatus({ state: 'failed', ...ids(), reason, message, command });
        return done(EXIT.FAILED, { ok: false, action: 'failed', error: reason, message, transientRuns: runs, ...extra });
      }
      const told = await tell(`transient:${reason}:${sha}`, `pipeline auto-update failed ${runs} runs in a row (${reason}): ${message}. To update by hand, run in your own terminal: ${command}`);
      writeStatus({ state: 'failed', ...ids(), reason, message, command });
      return done(EXIT.FAILED, { ok: false, action: 'failed', error: reason, message, transientRuns: runs, notify: told, ...extra });
    }
    delete state.transient;
    if (noRetry) state = { ...state, noRetry: { sha, reason, message } };
    persist();
    const told = await tell(`${reason}:${sha}`, text ?? `pipeline auto-update failed (${reason}): ${message}. Run in your own terminal and read its error: ${command}`);
    writeStatus({ state: 'failed', ...ids(), reason, message, command });
    return done(EXIT.FAILED, { ok: false, action: 'failed', error: reason, message, notify: told, ...extra });
  };
  const current = (sha) => {
    clearState();
    writeStatus({ state: 'current', installedSha: sha, mainSha: sha });
    return done(EXIT.OK, { ok: true, action: 'none' }, true);
  };

  try {
    main = auto.mainSha({ timeoutMs: NETWORK_TIMEOUT_MS, env, home });
    const before = auto.installedIdentity(home);
    installedSha = before?.sourceSha ?? null;
    if (!main.ok) return await failed('upstream-unresolved', `could not resolve upstream main: ${main.reason}`, { transient: true });
    const sha = main.sha;
    if (state.noRetry && state.noRetry.sha !== sha) { delete state.noRetry; persist(); }

    // A main sha whose install did not verify is not tried again (the next main sha is). Unless the owner has since put it right: the install
    // reads clean and is that sha AND the verification that failed passes again. "Clean" alone is not enough: isClean / installedIdentity read the
    // installed files and the manifest, never settings.json, so a failure that was only a missing hook registration looks clean from the start.
    if (state.noRetry) {
      let drift = [];
      if (isClean(before) && before.sourceSha === sha) {
        let v;
        try {
          v = typeof auto.verifyInstalled === 'function' ? await auto.verifyInstalled({ home, main, env, say }) : { ok: false, drift: [], error: 'no verification available' };
        } catch (err) {
          v = { ok: false, drift: [], error: String(err?.message ?? err).slice(0, 200) };
        }
        if (v?.ok === true) return current(sha);
        drift = Array.isArray(v?.drift) ? v.drift.slice(0, 5) : [];
      }
      const { reason, message } = state.noRetry;
      say(`scheduled update held: ${sha7(sha)} did not verify last time (${reason})`);
      writeStatus({ state: 'failed', ...ids(), reason, message, command });
      return done(EXIT.FAILED, { ok: false, action: 'held', error: reason, message, main: { sha }, ...(drift.length ? { drift } : {}) });
    }

    // Never overwrite what is not a pristine install of one known commit, whatever main is.
    if (!before || !isClean(before) || !before.sourceSha) return await blockedFor(before);
    const relation = before.sourceSha === sha ? { status: 'identical' } : auto.relate(before, main, env);
    if (relation.status === 'unresolved') return await failed('upstream-unresolved', `could not compare the install with main: ${relation.reason}`, { transient: true });
    if (relation.status === 'identical') return current(sha);
    // compare(installed, main): 'behind' = the installed commit has commits main lacks, 'diverged' = both do.
    if (relation.status === 'behind') return await blockedFor(before, 'ahead');
    if (relation.status !== 'ahead') return await blockedFor(before, 'diverged');

    // An update is available. The status says so while the download runs (a deferred streak keeps its own line).
    if (prev?.state !== 'deferred-by-review') writeStatus({ state: 'behind', ...ids() });
    const r = await auto.performUpdate({ home, main, before, relation, env, say, expectInstalled: before.sourceSha, requireNoLiveReviews: true, identityOf: auto.installedIdentity });
    const o = r.output;

    if (r.exitCode === EXIT.OK) {
      const after = o.installed?.sourceSha ?? sha;
      clearState();
      writeStatus({ state: 'current', installedSha: after, mainSha: sha, mainTitle: o.mainTitle });
      let told = { sent: true };
      try {
        await notifier(`pipeline updated to ${sha7(sha)}${o.mainTitle ? ` (${o.mainTitle})` : ''}`);
      } catch (err) {
        told = { sent: false, reason: 'error', error: String(err?.message ?? err).slice(0, 200) };
      }
      return done(EXIT.OK, { ok: true, action: 'updated', before: o.before, after: o.after, main: o.main, warnings: o.warnings ?? [], notify: told });
    }

    if (o.error === 'deferred') {
      const dreason = o.deferReason === 'deadline' || o.deferReason === 'admission-busy' ? o.deferReason : 'live';
      const by = dreason === 'live' ? normalizeLive(o.live) : [];
      // The count starts at the first deferral of an unbroken streak; a first-deferral time in the future means the clock went backwards.
      const prevSince = prev?.state === 'deferred-by-review' ? Date.parse(prev.deferredSince) : NaN;
      const since = Number.isFinite(prevSince) && prevSince <= nowDate.getTime() ? prev.deferredSince : checkedAt;
      const carried = state.deferNotified ? { deferNotified: state.deferNotified } : {};
      // 'deadline' / 'admission-busy' are not a review: they name their own cause, and like a busy install lock they tell the owner only on the 3rd run in a row.
      const cause = dreason === 'live' ? describeLive(by) : (o.message || dreason);
      const unchecked = dreason === 'live' && onlyScanErrors(by); // could not look: not a running review
      const message = unchecked ? `main ${sha7(sha)} deferred: could not check for running reviews: ${scanDetail(by)}`
        : dreason === 'live' ? `main ${sha7(sha)} waits for a live review: ${cause}` : `main ${sha7(sha)} deferred (${dreason}): ${cause}`;
      let streakTold;
      if (dreason === 'live') state = carried;
      else {
        const runs = (state.transient?.reason === dreason ? Number(state.transient.runs) || 0 : 0) + 1;
        state = { ...carried, ...(Array.isArray(state.notified) ? { notified: state.notified } : {}), transient: { reason: dreason, runs } };
        persist();
        if (runs >= TRANSIENT_RUNS) {
          const n = composeNotice({ head: `pipeline update to ${sha7(sha)} was deferred ${runs} runs in a row (${dreason}):`, cause, action: { plain: `It retries every run; to update by hand, run in your own terminal: ${command}` } });
          streakTold = await tell(`transient:${dreason}:${sha}`, n.text, { banner: n.banner });
        }
      }
      say(`scheduled update deferred: ${message}`);
      let told = streakTold;
      if (nowDate.getTime() - Date.parse(since) > DEFER_NOTICE_MS && state.deferNotified !== since) {
        try {
          const waiting = `pipeline update to ${sha7(sha)} has been waiting more than 24 hours`;
          const hints = hintsOf(by);
          const { pointer, fallbacks } = recoveryPointer(by, { leases: leasesCommand(home), statusPath });
          const tail = `run in your own terminal: ${command}`;
          const n = unchecked ? composeNotice({ head: `${waiting}: could not check for running reviews:`, cause: scanDetail(by), action: { lead: 'Fix that', hintLead: 'Fix that: ', hints, tail, pointer, fallbacks } })
            : dreason === 'live' ? composeNotice({ head: `${waiting} for live reviews:`, cause, action: { lead: 'Finish or close them', hintLead: 'Finish or close them; ', hints, tail, pointer, fallbacks } })
            : composeNotice({ head: `pipeline update to ${sha7(sha)} has been deferred for more than 24 hours (${dreason}):`, cause, action: { plain: `Run in your own terminal: ${command}` } });
          await notifier(n.text, { banner: n.banner });
          state = { ...state, deferNotified: since };
          told = { sent: true };
        } catch (err) {
          told = { sent: false, reason: 'error', error: String(err?.message ?? err).slice(0, 200) };
        }
      }
      persist();
      writeStatus({
        state: 'deferred-by-review', ...ids(), mainTitle: o.mainTitle, deferredSince: since,
        ...(dreason === 'live' ? { deferredBy: by } : { deferReason: dreason, message: cause }),
      });
      return done(EXIT.OK, { ok: true, action: 'deferred', reason: dreason, message, live: by, deferredSince: since, ...(told ? { notify: told } : {}) });
    }

    if (o.error === 'install-changed') {
      // The installed copy changed during the download. Nothing was written. Judge what is there now, as a fresh run would.
      const now = auto.installedIdentity(home);
      installedSha = now?.sourceSha ?? null;
      if (!now || !isClean(now) || !now.sourceSha) return await blockedFor(now);
      say(`scheduled update: the installed copy changed during the download (now ${sha7(now.sourceSha)}); judged again next run`);
      writeStatus({ state: 'behind', ...ids() });
      return done(EXIT.OK, { ok: true, action: 'changed', message: o.message, main: { sha } });
    }

    if (o.error === 'check-failed' || o.error === 'unverified') {
      const drift = Array.isArray(o.drift) ? o.drift.slice(0, 5) : [];
      const detail = drift.length ? drift.join('; ') : o.message;
      return await failed(o.error, o.message, {
        noRetry: true, extra: { drift },
        text: `pipeline update to ${sha7(sha)} was installed but did not verify: ${detail}. It will not be retried for this version. Check it in your own terminal: ${command}`,
      });
    }
    const busy = o.error === 'install-failed' && LOCK_BUSY.test(`${o.message ?? ''} ${o.stderr ?? ''}`);
    return await failed(busy ? 'install-lock-busy' : o.error, o.message, { transient: busy });
  } catch (err) {
    return await failed('crashed', `the scheduled update crashed: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}
