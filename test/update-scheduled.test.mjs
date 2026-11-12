// Why: `update --scheduled` runs unattended every few minutes and can replace the guard hooks, so what it must NOT do matters most: no install
// when current, no touching a modified / incomplete / ahead / diverged install, no install while a review is live, no retry of a version that did
// not verify, and no notification spam. Every dependency is injected (ctx.auto): no network, no real install, no real notification, and the
// status / bookkeeping files live in a scratch account home. The real download + installer-flag path is in update-scheduled-installer.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update, meta } from '../pipeline/commands/update.mjs';
import { emit } from '../pipeline/lib/cli.mjs';
import {
  DEFER_NOTICE_MS, STATE_FILE, STATUS_FILE, TRANSIENT_RUNS, composeNotice, describeLive, leasesCommand, normalizeLive, ownerCommand, pipelineStateDir,
} from '../pipeline/lib/auto-update.mjs';
import { scanLiveWork } from '../pipeline/lib/live-work-scan.mjs';
import { BANNER_MAX, defaultNotify } from '../pipeline/lib/queue-sweep.mjs';
import { openOrRenewLease } from '../pipeline/lib/review-lease.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-upd-sched-'))); made.push(d); return d; };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const T0 = Date.UTC(2026, 10, 11, 0, 0, 0);
const HOUR = 3600 * 1000;
const pristine = (sourceSha = OLD) => ({ stamp: `1.0+${sourceSha.slice(0, 7)}`, sourceSha, complete: true, sourceDirty: false, modified: [], missing: [], extra: [], scanError: [] });
const LIVE = [{ kind: 'review-lease', repo: 'acme/app', pr: 12, worktree: '/work/app-12' }, { kind: 'merge-queue', repo: 'acme/web', pr: 7, worktree: '/work/web-7' }];
const OK_INSTALL = { exitCode: 0, output: { ok: true, before: '1.0+ccccccc', after: '1.0+aaaaaaa', main: { sha: SHA_A }, mainTitle: 'Add the thing (#99)', installed: { sourceSha: SHA_A } } };
const failInstall = (error, message = 'boom', extra = {}) => ({ exitCode: 1, output: { ok: false, error, message, ...extra } });
const DEFERRED = { exitCode: 1, output: { ok: false, error: 'deferred', deferred: true, live: LIVE, message: 'a review is live' } };

// A rig: the world (main, installed identity, relation, install result, clock) is mutable between runs.
function rig(over = {}) {
  const dir = scratch();
  const w = { main: { ok: true, sha: SHA_A, via: 'gh' }, id: pristine(), relation: { status: 'ahead' }, install: OK_INSTALL, clock: T0, verify: { ok: true, drift: [] }, ...over };
  const calls = { install: [], relate: 0, notify: [], verify: [] };
  const auto = {
    mainSha: () => w.main,
    installedIdentity: () => w.id,
    relate: () => { calls.relate += 1; return w.relation; },
    performUpdate: async (args) => { calls.install.push(args); return w.install; },
    verifyInstalled: async (args) => { calls.verify.push(args); return w.verify; },
    notify: async (text) => { calls.notify.push(text); },
    now: () => new Date(w.clock),
    accountHome: join(dir, 'account'),
  };
  const home = join(dir, 'home');
  const go = (extra = {}) => update(['--scheduled', '--json', '--claude-home', home], { env: {}, hasClaudeCodeAncestor: () => false, auto: { ...auto, ...extra } });
  const stateDir = pipelineStateDir(auto.accountHome);
  const status = () => JSON.parse(readFileSync(join(stateDir, STATUS_FILE), 'utf8'));
  const bookkeeping = () => (existsSync(join(stateDir, STATE_FILE)) ? JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')) : null);
  return { w, calls, go, auto, dir, home, stateDir, status, bookkeeping };
}
const printed = (result) => { let out = ''; const code = emit(result, { stdout: { write: (s) => { out += s; } } }); return { out, code }; };

test('meta documents --scheduled and the schedule subcommand', () => {
  assert.match(meta.usage, /pipeline update --scheduled/);
  assert.match(meta.usage, /pipeline update schedule \(--install \[--every N\] \| --remove \| --status\)/);
});

test('--scheduled and --check cannot be combined', async () => {
  await assert.rejects(update(['--scheduled', '--check'], { env: {} }), /cannot be combined/);
});

test('--scheduled refuses inside Claude Code (CLAUDECODE=1 or an ancestor), before any lookup, and writes no status', async () => {
  for (const [env, ancestor] of [[{ CLAUDECODE: '1' }, false], [{}, true]]) {
    const t = rig();
    let touched = false;
    const spy = () => { touched = true; return t.w.main; };
    const r = await update(['--scheduled', '--json', '--claude-home', t.home], { env, hasClaudeCodeAncestor: () => ancestor, auto: { ...t.auto, mainSha: spy } });
    assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'refused']);
    assert.equal(touched, false);
    assert.equal(existsSync(t.stateDir), false, 'nothing written');
  }
});

test('manual `update` still refuses inside Claude Code', async () => {
  const r = await update(['--json'], { env: { CLAUDECODE: '1' }, hasClaudeCodeAncestor: () => false });
  assert.deepEqual([r.exitCode, r.output.error], [2, 'refused']);
});

test('current and unmodified: exit 0, silent, no compare, no install, no notice; the status says current and no bookkeeping is left', async () => {
  const t = rig({ id: pristine(SHA_A) });
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.equal(r.silent, true);
  assert.deepEqual(printed(r), { out: '', code: 0 });
  assert.equal(t.calls.install.length, 0);
  assert.equal(t.calls.relate, 0, 'the installed sha is main: no GitHub compare needed');
  assert.equal(t.calls.notify.length, 0);
  assert.deepEqual(t.status(), { version: 1, state: 'current', checkedAt: new Date(T0).toISOString(), installedSha: SHA_A, mainSha: SHA_A });
  assert.equal(t.bookkeeping(), null);
  // identical per the compare (e.g. a re-tagged install) is just as quiet
  const u = rig({ relation: { status: 'identical' } });
  assert.equal((await u.go()).silent, true);
  assert.equal(u.status().state, 'current');
});

test('behind: installs with expectInstalled + requireNoLiveReviews, tells the owner "pipeline updated to <sha7> (<PR title>)", status current', async () => {
  const t = rig();
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.equal(r.compact, true);
  assert.deepEqual([r.output.mode, r.output.ok, r.output.action, r.output.before, r.output.after], ['scheduled', true, 'updated', '1.0+ccccccc', '1.0+aaaaaaa']);
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.install[0].expectInstalled, OLD);
  assert.equal(t.calls.install[0].requireNoLiveReviews, true);
  assert.deepEqual(t.calls.notify, ['pipeline updated to aaaaaaa (Add the thing (#99))']);
  assert.deepEqual(t.status(), { version: 1, state: 'current', checkedAt: new Date(T0).toISOString(), installedSha: SHA_A, mainSha: SHA_A, mainTitle: 'Add the thing (#99)' });
  assert.equal(t.bookkeeping(), null);
  const lines = printed(r).out.trimEnd().split('\n');
  assert.equal(lines.length, 1, 'one compact line for the job log');
  assert.equal(JSON.parse(lines[0]).action, 'updated');
});

test('the updated notice works without a title, and a notifier that throws never changes the outcome', async () => {
  const t = rig({ install: { exitCode: 0, output: { ...OK_INSTALL.output, mainTitle: null } } });
  assert.equal((await t.go()).output.action, 'updated');
  assert.deepEqual(t.calls.notify, ['pipeline updated to aaaaaaa']);
  const u = rig();
  const r = await u.go({ notify: async () => { throw new Error('banner down'); } });
  assert.deepEqual([r.exitCode, r.output.action, r.output.notify.sent], [0, 'updated', false]);
});

test('deferred by a live review: exit 0, one log line naming what is live, status deferred-by-review with the holders, nothing told', async () => {
  const t = rig({ install: DEFERRED });
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.action, 'deferred');
  assert.match(r.output.message, /acme\/app #12 \(\/work\/app-12\)/);
  assert.match(r.output.message, /acme\/web #7/);
  assert.equal(printed(r).out.trimEnd().split('\n').length, 1);
  assert.equal(t.calls.notify.length, 0);
  assert.deepEqual(t.status(), {
    version: 1, state: 'deferred-by-review', checkedAt: new Date(T0).toISOString(), installedSha: OLD, mainSha: SHA_A,
    deferredSince: new Date(T0).toISOString(),
    deferredBy: [
      { repo: 'acme/app', pr: 12, worktree: '/work/app-12', kind: 'review-lease' },
      { repo: 'acme/web', pr: 7, worktree: '/work/web-7', kind: 'merge-queue' },
    ],
  });
  // it keeps trying: the review ends, the next run installs and the status is current again
  t.w.clock += 5 * 60 * 1000;
  t.w.install = OK_INSTALL;
  assert.equal((await t.go()).output.action, 'updated');
  assert.equal(t.status().state, 'current');
  assert.equal(t.status().deferredSince, undefined);
});

test('deferred for more than 24 hours: ONE notice naming the lease holders; deferredSince survives the runs in between', async () => {
  const t = rig({ install: DEFERRED });
  await t.go();
  const since = new Date(T0).toISOString();
  t.w.clock = T0 + DEFER_NOTICE_MS - 60 * 1000;
  await t.go();
  assert.equal(t.calls.notify.length, 0, 'just under 24 h: quiet');
  t.w.clock = T0 + DEFER_NOTICE_MS + 60 * 1000;
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0], /more than 24 hours/);
  assert.match(t.calls.notify[0], /acme\/app #12/);
  assert.match(t.calls.notify[0], /acme\/web #7/);
  assert.equal(t.status().deferredSince, since, 'the count is from the first deferral');
  t.w.clock = T0 + 3 * DEFER_NOTICE_MS;
  await t.go();
  assert.equal(t.calls.notify.length, 1, 'one notice per streak');
});

test('a clock that jumps backwards starts the 24 hour count again (no early notice, a fresh one later)', async () => {
  const t = rig({ install: DEFERRED });
  await t.go();
  t.w.clock = T0 + 30 * HOUR;
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  // the clock is set back 40 hours: the old first-deferral time is in the future, so it is not trusted
  t.w.clock = T0 - 10 * HOUR;
  await t.go();
  assert.equal(t.status().deferredSince, new Date(T0 - 10 * HOUR).toISOString());
  assert.equal(t.calls.notify.length, 1, 'no notice from a bogus long wait');
  t.w.clock = T0 - 10 * HOUR + DEFER_NOTICE_MS + 60 * 1000;
  await t.go();
  assert.equal(t.calls.notify.length, 2, 'the new streak earns its own notice after 24 h');
});

test('a transient failure inside a deferred streak does not break its continuity', async () => {
  const t = rig({ install: DEFERRED });
  await t.go();
  t.w.main = { ok: false, reason: 'offline' };
  t.w.clock = T0 + 10 * HOUR;
  assert.equal((await t.go()).output.action, 'failed');
  assert.equal(t.status().state, 'deferred-by-review', 'one glitch leaves the status alone');
  assert.equal(t.status().checkedAt, new Date(T0 + 10 * HOUR).toISOString());
  t.w.main = { ok: true, sha: SHA_A, via: 'gh' };
  t.w.clock = T0 + 25 * HOUR;
  await t.go();
  assert.equal(t.status().deferredSince, new Date(T0).toISOString());
  assert.equal(t.calls.notify.length, 1);
});

test('the installer reports the install changed during the download: nothing is installed; a now-modified copy is a pause the owner hears about once', async () => {
  const t = rig({ install: failInstall('install-changed', 'the installed copy changed while the update was downloading') });
  // by the time the run looks again, the owner has edited a file
  let looks = 0;
  const installedIdentity = () => (looks++ === 0 ? pristine() : { ...pristine(), modified: ['pipeline/lib/x.mjs'] });
  const r = await t.go({ installedIdentity });
  assert.deepEqual([r.exitCode, r.output.action, r.output.reason], [0, 'blocked', 'modified']);
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.notify.length, 1);
  assert.equal(t.status().state, 'blocked-modified');
  assert.equal(t.status().reason, 'modified');
});

test('the install changed during the download into another CLEAN install (a manual update): no install, no notice, judged again next run', async () => {
  const t = rig({ install: failInstall('install-changed', 'changed') });
  let looks = 0;
  const installedIdentity = () => (looks++ === 0 ? pristine() : pristine(SHA_A));
  const r = await t.go({ installedIdentity });
  assert.deepEqual([r.exitCode, r.output.action], [0, 'changed']);
  assert.equal(t.calls.notify.length, 0);
  assert.deepEqual([t.status().state, t.status().installedSha], ['behind', SHA_A]);
});

test('an interrupted install, then an owner edit: never auto-installed; the owner is told once per (reason, main sha) with the exact command', async () => {
  const t = rig({ id: { ...pristine(), complete: false, missing: ['pipeline/lib/y.mjs'] } });
  let r = await t.go();
  assert.deepEqual([r.exitCode, r.output.action, r.output.reason], [0, 'blocked', 'incomplete']);
  assert.equal(t.calls.install.length, 0);
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0], /paused/);
  assert.ok(t.calls.notify[0].includes(ownerCommand(t.home)), t.calls.notify[0]);
  assert.match(t.calls.notify[0], /main aaaaaaa/);
  assert.deepEqual(t.status(), {
    version: 1, state: 'blocked-modified', checkedAt: new Date(T0).toISOString(), installedSha: OLD, mainSha: SHA_A, reason: 'incomplete',
    message: 'the installed pipeline is incomplete (an interrupted install?)', command: ownerCommand(t.home),
  });
  await t.go();
  assert.equal(t.calls.notify.length, 1, 'same (reason, main sha): quiet');
  // the owner (or something else) now edits a file of the half-installed copy: a different reason at the same sha
  t.w.id = { ...pristine(), modified: ['pipeline/lib/x.mjs'] };
  r = await t.go();
  assert.equal(r.output.reason, 'modified');
  assert.equal(t.calls.notify.length, 2);
  await t.go();
  assert.equal(t.calls.notify.length, 2);
  // a new main sha is a new key
  t.w.main = { ok: true, sha: SHA_B, via: 'gh' };
  await t.go();
  assert.equal(t.calls.notify.length, 3);
  assert.equal(t.calls.install.length, 0, 'never installed');
  assert.equal(t.status().mainSha, SHA_B);
});

test('ahead of main, diverged, nothing installed, or no recorded source commit: left alone, owner told once', async () => {
  for (const [over, reason] of [
    [{ relation: { status: 'behind' } }, 'ahead'],
    [{ relation: { status: 'diverged' } }, 'diverged'],
    [{ id: null }, 'modified'],
    [{ id: { ...pristine(), sourceSha: null } }, 'modified'],
    [{ id: { ...pristine(), sourceDirty: true } }, 'modified'],
    [{ id: { ...pristine(), extra: ['pipeline/lib/stray.mjs'] } }, 'modified'],
  ]) {
    const t = rig(over);
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.action, r.output.reason], [0, 'blocked', reason], JSON.stringify(over));
    assert.equal(t.calls.install.length, 0);
    assert.equal(t.calls.notify.length, 1);
    assert.equal(t.status().state, 'blocked-modified');
    await t.go();
    assert.equal(t.calls.notify.length, 1);
  }
});

test('a failed verify: ONE notice with the drift list, exit 1, status failed; that main sha is not retried (even though the install now reads modified); the next sha is', async () => {
  const t = rig({ install: failInstall('check-failed', 'the install did not verify: a; b', { drift: ['hook a is missing', 'unit b differs'] }) });
  const r = await t.go();
  assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [1, false, 'check-failed']);
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0], /did not verify: hook a is missing; unit b differs/);
  assert.match(t.calls.notify[0], /will not be retried/);
  assert.deepEqual([t.status().state, t.status().reason, t.status().command], ['failed', 'check-failed', ownerCommand(t.home)]);
  // the next run finds the half-verified install modified: no second notice, no retry
  t.w.id = { ...pristine(SHA_A), modified: ['pipeline/hooks/guard-files.mjs'] };
  const held = await t.go();
  assert.deepEqual([held.exitCode, held.output.action], [1, 'held']);
  assert.equal(t.calls.install.length, 1, 'not retried');
  assert.equal(t.calls.notify.length, 1, 'not told again');
  assert.equal(t.status().state, 'failed');
  // the owner repairs it by hand: the install is main and clean, so the job is current and forgets
  t.w.id = pristine(SHA_A);
  assert.equal((await t.go()).silent, true);
  assert.equal(t.status().state, 'current');
  assert.equal(t.bookkeeping(), null);
  // and a new main sha is tried again
  const u = rig({ install: failInstall('check-failed', 'm', { drift: ['x'] }) });
  await u.go();
  u.w.main = { ok: true, sha: SHA_B, via: 'gh' };
  await u.go();
  assert.equal(u.calls.install.length, 2);
  assert.equal(u.calls.notify.length, 2);
});

// R1-B4: isClean / installedIdentity never read settings.json, so a settings-only verify failure (a guard hook not registered) already reads "clean and
// identical". Clearing the hold needs the check that failed to pass again, not just a clean-looking install.
test('a failed verify on a settings-only problem is NOT cleared by a clean-looking install: it stays failed until the check passes', async () => {
  const t = rig({ install: failInstall('check-failed', 'the install did not verify: guard hook not registered', { drift: ['guard-git hook is not registered in settings.json'] }) });
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  // the install files are pristine main (the failure was in settings.json), the hook is still missing
  t.w.id = pristine(SHA_A);
  t.w.verify = { ok: false, drift: ['guard-git hook is not registered in settings.json'] };
  for (let i = 0; i < 2; i += 1) {
    const held = await t.go();
    assert.deepEqual([held.exitCode, held.output.action, held.silent], [1, 'held', undefined], `run ${i + 1}`);
    assert.equal(t.status().state, 'failed');
    assert.equal(t.status().reason, 'check-failed');
    assert.equal(t.bookkeeping().noRetry.sha, SHA_A, 'the hold is kept');
  }
  assert.equal(t.calls.verify.length, 2, 'the failed check was re-run each time');
  assert.equal(t.calls.install.length, 1, 'not retried');
  assert.equal(t.calls.notify.length, 1, 'not told again');
  // a verification that cannot run (offline) does not clear it either
  t.w.verify = { ok: false, drift: [], error: 'fetch failed' };
  assert.equal((await t.go()).output.action, 'held');
  assert.equal(t.bookkeeping().noRetry.sha, SHA_A);
  // the owner registers the hook: the same check passes, the job is current and forgets
  t.w.verify = { ok: true, drift: [] };
  assert.equal((await t.go()).silent, true);
  assert.equal(t.status().state, 'current');
  assert.equal(t.bookkeeping(), null);
});

test('an install that ends unverified (the installed stamp is not main) is treated like a failed verify', async () => {
  const t = rig({ install: failInstall('unverified', 'the installed copy reads 1.0+ccccccc, not a clean aaaaaaa') });
  assert.equal((await t.go()).exitCode, 1);
  t.w.id = { ...pristine(), modified: ['x'] };
  await t.go();
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.notify.length, 1);
});

test('a transient streak: runs 1 and 2 are quiet (the status stays), run 3 tells once, run 4 is quiet; a good run resets the count', async () => {
  const t = rig({ id: pristine(SHA_A) });
  await t.go(); // a good run first, so there is a status to keep
  t.w.main = { ok: false, reason: 'offline' };
  for (let i = 1; i <= TRANSIENT_RUNS; i += 1) {
    t.w.clock += 60 * 1000;
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.error], [1, 'upstream-unresolved']);
    assert.equal(t.calls.notify.length, i < TRANSIENT_RUNS ? 0 : 1, `run ${i}`);
    assert.equal(t.status().state, i < TRANSIENT_RUNS ? 'current' : 'failed', `status after run ${i}`);
  }
  assert.equal(t.status().mainSha, null);
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  // a good run clears the streak: it takes three more in a row to tell again
  t.w.main = { ok: true, sha: SHA_A, via: 'gh' };
  await t.go();
  assert.equal(t.bookkeeping(), null);
  t.w.main = { ok: false, reason: 'offline' };
  await t.go(); await t.go();
  assert.equal(t.calls.notify.length, 1);
  await t.go();
  assert.equal(t.calls.notify.length, 2);
});

test('a busy install lock and an unresolved compare are transient too', async () => {
  const busy = rig({ install: failInstall('install-failed', 'another install is running in /h. Wait for it to finish') });
  for (let i = 1; i <= TRANSIENT_RUNS; i += 1) {
    const r = await busy.go();
    assert.deepEqual([r.exitCode, r.output.error], [1, 'install-lock-busy']);
    assert.equal(busy.calls.notify.length, i < TRANSIENT_RUNS ? 0 : 1, `run ${i}`);
  }
  const cmp = rig({ relation: { status: 'unresolved', reason: 'rate limited' } });
  for (let i = 0; i < TRANSIENT_RUNS - 1; i += 1) assert.equal((await cmp.go()).output.error, 'upstream-unresolved');
  assert.equal(cmp.calls.notify.length, 0);
  await cmp.go();
  assert.equal(cmp.calls.notify.length, 1);
});

test('any other failure tells once per (reason, main sha); a good run lets the same failure tell again', async () => {
  for (const error of ['fetch-failed', 'installer-too-old', 'install-failed']) {
    const t = rig({ install: failInstall(error, 'm') });
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.error], [1, error]);
    assert.equal(t.calls.notify.length, 1);
    assert.match(t.calls.notify[0], new RegExp(`failed \\(${error}\\)`));
    await t.go();
    assert.equal(t.calls.notify.length, 1);
    t.w.main = { ok: true, sha: SHA_B, via: 'gh' };
    await t.go();
    assert.equal(t.calls.notify.length, 2, 'a new main sha is a new key');
  }
  const t = rig({ install: failInstall('fetch-failed', 'm') });
  await t.go();
  t.w.install = OK_INSTALL;
  await t.go();
  t.w.install = failInstall('fetch-failed', 'm');
  t.w.id = pristine();
  await t.go();
  assert.equal(t.calls.notify.length, 3, 'failure, then the update notice, then the failure again');
});

test('a notice that could not be delivered is retried next run; a crash in the run is a failure, not a thrown error', async () => {
  const t = rig({ install: failInstall('fetch-failed', 'm') });
  let down = true;
  const notify = async (text) => { t.calls.notify.push(text); if (down) throw new Error('banner down'); };
  const r = await t.go({ notify });
  assert.deepEqual([r.exitCode, r.output.notify.sent], [1, false]);
  down = false;
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 2);
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 2, 'delivered now: quiet');
  const c = rig({});
  const crashed = await c.go({ performUpdate: async () => { throw new Error('kaboom'); } });
  assert.deepEqual([crashed.exitCode, crashed.output.error], [1, 'crashed']);
  assert.match(crashed.output.message, /kaboom/);
});

test('the status file is always version 1, atomic (no temp files left), and names installedSha / mainSha even when unknown', async () => {
  const t = rig({ main: { ok: false, reason: 'offline' }, id: null });
  await t.go();
  assert.deepEqual(t.status(), { version: 1, state: 'failed', checkedAt: new Date(T0).toISOString(), installedSha: null, mainSha: null, reason: 'upstream-unresolved', message: 'could not resolve upstream main: offline', command: ownerCommand(t.home) });
  assert.deepEqual(readdirSync(t.stateDir).filter((n) => n.endsWith('.tmp')), []);
});

test('each run of each kind ends with exactly one valid state in the status file', async () => {
  const kinds = {
    current: rig({ id: pristine(SHA_A) }),
    updated: rig(),
    deferred: rig({ install: DEFERRED }),
    blocked: rig({ id: { ...pristine(), modified: ['x'] } }),
    failed: rig({ install: failInstall('fetch-failed') }),
  };
  const expected = { current: 'current', updated: 'current', deferred: 'deferred-by-review', blocked: 'blocked-modified', failed: 'failed' };
  for (const [name, t] of Object.entries(kinds)) {
    await t.go();
    const s = t.status();
    assert.equal(s.version, 1);
    assert.equal(s.state, expected[name], name);
    assert.equal(s.checkedAt, new Date(T0).toISOString());
    assert.ok('installedSha' in s && 'mainSha' in s);
  }
});

test('ownerCommand: the default home is spelled ~/.claude; another home is quoted and named', () => {
  const user = scratch();
  assert.equal(ownerCommand(join(user, '.claude'), user), 'node ~/.claude/pipeline/bin/pipeline.mjs update');
  const odd = join(user, "it's here");
  const cmd = ownerCommand(odd, user);
  assert.ok(cmd.includes(`--claude-home '${odd.replace(/'/g, `'\\''`)}'`), cmd);
});

test('normalizeLive / describeLive: repo, PR and worktree are named; unknown shapes still say something', () => {
  assert.deepEqual(normalizeLive(null), []);
  assert.deepEqual(normalizeLive([{ repoId: 'r', branch: 'feat', worktree: '/w' }, 'a held lock']), [
    { repo: 'r', pr: 'feat', worktree: '/w' }, { repo: null, pr: null, worktree: null, what: 'a held lock' },
  ]);
  assert.equal(describeLive([]), 'a review is live');
  assert.equal(describeLive(normalizeLive(LIVE)), 'acme/app #12 (/work/app-12); acme/web #7 (/work/web-7)');
  assert.match(describeLive(normalizeLive(Array.from({ length: 7 }, (_, i) => ({ repo: `r${i}`, pr: i })))), /and 2 more$/);
});

// R3-F2: an entry that names no PR (a job, a held state or merge lock) is told apart by its detail, not just "/repo (/worktree)" or a bare kind.
test('R3-F2: describeLive shows the detail of job / state-lock / merge-lock entries that name no PR, and leaves entries with a PR as they were', () => {
  const job = { kind: 'job', repo: '/work/app', worktree: '/work/app', detail: 'job ci has an unreadable record (meta.json), treated as running: remove .review/jobs/ci in that worktree if it is stale' };
  const text = describeLive(normalizeLive([job]));
  // #258: the remove instruction is a hint field now; describeLive keeps the cause and never prints a hint.
  assert.match(text, /job ci has an unreadable record \(meta\.json\), treated as running$/);
  assert.doesNotMatch(text, /remove/);
  assert.match(text, /\/work\/app/);
  assert.match(describeLive(normalizeLive([{ kind: 'state-lock', detail: 'pr-state-acme-app-7 is held by pid 9 on host, since T' }])), /state-lock.*pr-state-acme-app-7 is held by pid 9/);
  assert.match(describeLive(normalizeLive([{ kind: 'merge-lock', detail: 'the merge command record merge-x.child.json is unreadable (not JSON), treated as running' }])), /merge-lock.*merge-x\.child\.json is unreadable/);
  const withPr = { kind: 'lease', repo: 'acme/app', pr: 12, worktree: '/w', detail: 'lease detail that stays out of the line' };
  assert.equal(describeLive(normalizeLive([withPr])), 'acme/app #12 (/w)');
});

// Real scan output for the hint tests below (#258 asks for the notice to be driven by what scanLiveWork returns, not a hand-written copy). One scratch machine: its own lock, lease
// and home folders, and a git repository at a (long) path whose `.review/jobs/<name>/meta.json` is corrupt.
const LEASE_ENV = (dir) => ({ PIPELINE_LOCK_DIR: join(dir, 'locks'), PIPELINE_REVIEW_LEASE_DIR: join(dir, 'leases'), PIPELINE_MACHINE_ID: 'test-machine-id' });
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}
function brokenJobRepo(dir, repoName, jobName) {
  const repo = gitRepo(join(dir, repoName));
  const jobDir = join(repo, '.review', 'jobs', jobName);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'meta.json'), '{ not json');
  return repo;
}
function scanOf(dir, repos, leaseOpts = {}) {
  mkdirSync(join(dir, 'locks'), { recursive: true });
  return scanLiveWork({ env: LEASE_ENV(dir), home: join(dir, 'home'), repos, leaseOpts });
}
const hintOf = (name) => `remove .review/jobs/${name} in that worktree if it is stale`;

// R4-F1: the remove hint is never cut: a long worktree path and job name must not produce a hint naming a different folder. It is its own field now (#258), whole or dropped (> 300).
test('R4-F1 / #258: a job hint for a long worktree and a long job name, from REAL scan output, is whole in its own field or absent after normalizeLive, and never inside detail or describeLive', () => {
  const dir = scratch();
  const longRepo = 'agent-a-rather-long-worktree-name-for-this-task-xx-and-some-more-to-be-sure-it-is-long';
  for (const name of ['codex-review-final-pass', 'a'.repeat(60)]) {
    const repo = brokenJobRepo(dir, `${longRepo}-${name.length}`, name);
    assert.ok(repo.length >= 85);
    const real = scanOf(dir, [repo]).filter((e) => e.kind === 'job');
    assert.equal(real.length, 1, JSON.stringify(real));
    assert.ok(real[0].detail.endsWith(`: ${hintOf(name)}`), 'the scan keeps the legacy text for older installed readers');
    const [by] = normalizeLive(real);
    assert.equal(by.hint, hintOf(name), 'the hint travels whole');
    assert.ok(by.detail.startsWith(`job ${name} has an unreadable record`), 'the cause stays');
    assert.ok(!by.detail.includes('remove'), `no hint inside detail: ${by.detail}`);
    const text = describeLive([by]);
    assert.ok(text.includes(`(${repo})`), 'the worktree is printed');
    assert.ok(!text.includes('remove'), `describeLive never carries a hint: ${text}`);
  }
  // a name so long that the hint cannot be trusted whole (> 300): the hint is dropped, never cut, and the legacy suffix is gone from detail too
  const long = 'j'.repeat(250);
  const repo = brokenJobRepo(dir, 'dropped', long);
  const [dropped] = normalizeLive(scanOf(dir, [repo]).filter((e) => e.kind === 'job'));
  assert.ok(hintOf(long).length > 300);
  assert.equal(dropped.hint, undefined, 'dropped, not cut');
  assert.ok(dropped.detail.length <= 200);
  assert.ok(!dropped.detail.includes('remove'), dropped.detail);
  assert.ok(dropped.detail.startsWith(`job ${long.slice(0, 40)}`));
});

test('#258 skew: an OLDER installer sends the hint only inside detail: normalizeLive moves the legacy suffix into hint; a hint field and the suffix together are not doubled; other hints are left alone', () => {
  const legacy = `job x has an unreadable record (meta.json), treated as running: ${hintOf('x')}`;
  const [old] = normalizeLive([{ kind: 'job', worktree: '/w', detail: legacy }]);
  assert.deepEqual({ detail: old.detail, hint: old.hint }, { detail: 'job x has an unreadable record (meta.json), treated as running', hint: hintOf('x') });
  const [both] = normalizeLive([{ kind: 'job', worktree: '/w', detail: legacy, hint: hintOf('x') }]);
  assert.deepEqual({ detail: both.detail, hint: both.hint }, { detail: old.detail, hint: hintOf('x') });
  const [scanErr] = normalizeLive([{ kind: 'scan-error', detail: 'cannot judge the review lease of proc-1-aaaaaaaa', hint: 'delete /l/proc-1-aaaaaaaa.json if no pipeline command is running in a terminal' }]);
  assert.equal(scanErr.hint, 'delete /l/proc-1-aaaaaaaa.json if no pipeline command is running in a terminal');
  assert.equal(scanErr.detail, 'cannot judge the review lease of proc-1-aaaaaaaa');
  assert.equal(normalizeLive([{ kind: 'job', detail: 'job y is running' }])[0].hint, undefined);
  assert.equal(normalizeLive([{ kind: 'job', detail: 'job y', hint: 5 }])[0].hint, undefined, 'a hint that is not text is ignored');
  assert.equal(normalizeLive([{ kind: 'job', detail: 'job y', hint: `delete ${'p'.repeat(300)}` }])[0].hint, undefined, '> 300 characters: dropped');
  assert.ok(!describeLive(normalizeLive([{ kind: 'job', worktree: '/w', detail: legacy }])).includes('remove'));
});

test('defaultNotify with event pipeline-update: its own stderr prefix, notices log and banner title; the queue sweep keeps its own', () => {
  for (const [event, prefix, log, title] of [
    ['pipeline-update', 'pipeline-update', 'pipeline-update-notices.log', 'claude-pipeline update'],
    [undefined, 'queue-sweep', 'queue-sweep-notices.log', 'claude-pipeline merge queue'],
  ]) {
    const dir = scratch();
    let err = '';
    const spawned = [];
    defaultNotify({ env: { PIPELINE_PRUNE_LOG_DIR: dir }, platform: 'darwin', stderr: { write: (s) => { err += s; } }, spawn: (...a) => spawned.push(a), ...(event ? { event } : {}) })('hello  there');
    assert.equal(err, `${prefix}: hello  there\n`);
    assert.match(readFileSync(join(dir, log), 'utf8'), / hello there\n$/);
    assert.match(spawned[0][1][1], new RegExp(`with title "${title}"`));
  }
});

// ---- gaps closed after auditing plan B2/B4, and the cases of #67 that still apply --------------------------------------------------------

test('status file while the download runs says behind; a deferred streak keeps its own line; a verify failure leaves the full failed record', async () => {
  const t = rig();
  let during = null;
  await t.go({ performUpdate: async () => { during = t.status(); return OK_INSTALL; } });
  assert.deepEqual(during, { version: 1, state: 'behind', checkedAt: new Date(T0).toISOString(), installedSha: OLD, mainSha: SHA_A });

  const d = rig({ install: DEFERRED });
  await d.go();
  let streak = null;
  d.w.clock = T0 + 60 * 1000;
  await d.go({ performUpdate: async () => { streak = d.status(); return DEFERRED; } });
  assert.equal(streak.state, 'deferred-by-review', 'an update waiting on a review is not relabelled behind');
  assert.equal(streak.deferredSince, new Date(T0).toISOString());

  const f = rig({ install: failInstall('check-failed', 'the install did not verify: a; b', { drift: ['a', 'b'] }) });
  await f.go();
  assert.deepEqual(f.status(), {
    version: 1, state: 'failed', checkedAt: new Date(T0).toISOString(), installedSha: OLD, mainSha: SHA_A, reason: 'check-failed',
    message: 'the install did not verify: a; b', command: ownerCommand(f.home),
  });
});

test('every reason that blocks the job tells the owner the exact manual command and the main sha, and never installs', async () => {
  for (const [over, reason, phrase] of [
    [{ relation: { status: 'behind' } }, 'ahead', /ahead of main/],
    [{ relation: { status: 'diverged' } }, 'diverged', /diverged from main/],
    [{ id: { ...pristine(), modified: ['pipeline/lib/x.mjs'] } }, 'modified', /local changes/],
    [{ id: { ...pristine(), complete: false, missing: ['pipeline/lib/y.mjs'] } }, 'incomplete', /incomplete/],
  ]) {
    const t = rig(over);
    await t.go();
    assert.equal(t.calls.install.length, 0, reason);
    assert.equal(t.calls.notify.length, 1, reason);
    assert.match(t.calls.notify[0], phrase, reason);
    assert.match(t.calls.notify[0], /main aaaaaaa/, reason);
    assert.ok(t.calls.notify[0].endsWith(`run in your own terminal: ${ownerCommand(t.home)}`), t.calls.notify[0]);
    assert.deepEqual([t.status().state, t.status().reason, t.status().command], ['blocked-modified', reason, ownerCommand(t.home)]);
  }
});

test('alternating failures at one main sha tell each (reason, main sha) exactly once until a good run (#67 R1-B2)', async () => {
  const t = rig({ install: failInstall('fetch-failed', 'm') });
  const order = ['fetch-failed', 'installer-too-old', 'fetch-failed', 'installer-too-old', 'fetch-failed'];
  for (const error of order) { t.w.install = failInstall(error, 'm'); await t.go(); }
  assert.equal(t.calls.notify.length, 2, 'the third and later runs repeat a failure the owner already heard');
  assert.deepEqual(t.bookkeeping().notified, [`fetch-failed:${SHA_A}`, `installer-too-old:${SHA_A}`]);
  t.w.install = OK_INSTALL;
  await t.go();
  t.w.install = failInstall('fetch-failed', 'm');
  t.w.id = pristine();
  await t.go();
  assert.equal(t.calls.notify.length, 4, 'updated notice, then the same failure is news again');
});

test('only the quiet run prints nothing: every other outcome is exactly one compact JSON line for the job log', async () => {
  const kinds = {
    updated: rig(), deferred: rig({ install: DEFERRED }), blocked: rig({ id: { ...pristine(), modified: ['x'] } }),
    failed: rig({ install: failInstall('fetch-failed') }), changed: rig({ install: failInstall('install-changed', 'c') }),
  };
  for (const [name, t] of Object.entries(kinds)) {
    const { out, code } = printed(await t.go());
    const lines = out.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `${name}: ${out}`);
    assert.equal(out.endsWith('\n'), true);
    assert.equal(JSON.parse(lines[0]).mode, 'scheduled', name);
    assert.equal(code, name === 'failed' ? 1 : 0, name);
  }
  assert.equal(printed(await rig({ id: pristine(SHA_A) }).go()).out, '');
});

test('a 24 hour notice that could not be delivered is retried on the next run; a good run ends the streak so a later deferral can earn a new notice', async () => {
  const t = rig({ install: DEFERRED });
  await t.go();
  let down = true;
  const notify = async (text) => { t.calls.notify.push(text); if (down) throw new Error('banner down'); };
  t.w.clock = T0 + DEFER_NOTICE_MS + 60 * 1000;
  const r = await t.go({ notify });
  assert.deepEqual([r.exitCode, r.output.action, r.output.notify.sent], [0, 'deferred', false]);
  down = false;
  t.w.clock += 60 * 1000;
  assert.equal((await t.go({ notify })).output.notify.sent, true);
  t.w.clock += 60 * 1000;
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 2, 'delivered once, then quiet');
  // the review ends and the install goes through; the next deferral is a new streak with its own clock and notice
  t.w.install = OK_INSTALL;
  t.w.clock += 60 * 1000;
  await t.go({ notify });
  assert.equal(t.bookkeeping(), null);
  t.w.install = DEFERRED;
  t.w.id = pristine();
  t.w.clock += 60 * 1000;
  await t.go({ notify });
  assert.equal(t.status().deferredSince, new Date(t.w.clock).toISOString());
  t.w.clock += DEFER_NOTICE_MS + 60 * 1000;
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 4, 'updated notice + the new streak\'s own 24 h notice');
});

test('the default notifier is the pipeline-update one: the install notice reaches stderr and pipeline-update-notices.log, with no banner when it is switched off', async () => {
  const logDir = scratch();
  const t = rig();
  const { notify: _unused, ...auto } = t.auto;
  let err = '';
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { err += String(chunk); const cb = rest.find((a) => typeof a === 'function'); if (cb) cb(); return true; };
  let r;
  try {
    r = await update(['--scheduled', '--json', '--claude-home', t.home], { env: { PIPELINE_PRUNE_LOG_DIR: logDir, PIPELINE_NO_BANNER: '1' }, hasClaudeCodeAncestor: () => false, auto });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.deepEqual([r.exitCode, r.output.action, r.output.notify], [0, 'updated', { sent: true }]);
  assert.equal(err, 'pipeline-update: pipeline updated to aaaaaaa (Add the thing (#99))\n');
  assert.match(readFileSync(join(logDir, 'pipeline-update-notices.log'), 'utf8'), / pipeline updated to aaaaaaa \(Add the thing \(#99\)\)\n$/);
  assert.equal(existsSync(join(logDir, 'queue-sweep-notices.log')), false, 'not the queue sweep\'s log');
});

// ---- R1-F3: the installer's exit 3 carries a reason (live | deadline | admission-busy) and a message; none of them is "a review is live" except the first ----
const deferredBy = (reason, message) => ({ exitCode: 1, output: { ok: false, error: 'deferred', deferred: true, live: [], deferReason: reason, message } });
const DEADLINE = deferredBy('deadline', 'the live-work scan did not finish before its deadline');
const BUSY_ADMISSION = deferredBy('admission-busy', 'pipeline update in progress, retry in a minute');

test('a scan deadline overrun is deferred with its own reason and wording: never "a review is live"; retried every run, no notice before the 3rd in a row', async () => {
  const t = rig({ install: DEADLINE });
  for (let i = 1; i <= TRANSIENT_RUNS; i += 1) {
    t.w.clock += 60 * 1000;
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.action, r.output.reason], [0, 'deferred', 'deadline'], `run ${i}`);
    assert.doesNotMatch(r.output.message, /review is live|waits for a live review/, `run ${i}`);
    assert.match(r.output.message, /deadline/);
    assert.equal(t.status().state, 'deferred-by-review');
    assert.equal(t.status().deferReason, 'deadline');
    assert.equal(t.status().deferredBy, undefined);
    assert.equal(t.calls.notify.length, i < TRANSIENT_RUNS ? 0 : 1, `notices after run ${i}`);
  }
  assert.match(t.calls.notify[0], /3 runs in a row \(deadline\)/);
  assert.doesNotMatch(t.calls.notify[0], /a review is live|running review/);
  assert.ok(t.calls.notify[0].includes(ownerCommand(t.home)));
  await t.go();
  assert.equal(t.calls.notify.length, 1, 'one notice per streak');
});

test('admission-busy defers the same way, with its own wording; a live-review deferral in between breaks the streak; a good run ends it', async () => {
  const t = rig({ install: BUSY_ADMISSION });
  await t.go(); await t.go();
  assert.equal(t.status().deferReason, 'admission-busy');
  t.w.install = DEFERRED; // a real live review: the streak of "busy" runs is broken
  await t.go();
  assert.equal(t.status().deferReason, undefined);
  assert.equal(t.status().deferredBy.length, 2);
  t.w.install = BUSY_ADMISSION;
  await t.go(); await t.go();
  assert.equal(t.calls.notify.length, 0, 'the count started again');
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0], /\(admission-busy\)/);
  t.w.install = OK_INSTALL;
  assert.equal((await t.go()).output.action, 'updated');
  assert.equal(t.status().state, 'current');
  assert.equal(t.status().deferReason, undefined);
});

test('a deadline deferral longer than 24 hours earns ONE notice that names the real cause, not a review', async () => {
  const t = rig({ install: DEADLINE });
  await t.go();
  t.w.clock = T0 + DEFER_NOTICE_MS + 60 * 1000;
  await t.go();
  const day = t.calls.notify.filter((n) => /more than 24 hours/.test(n));
  assert.equal(day.length, 1);
  assert.match(day[0], /live-work scan did not finish before its deadline/);
  assert.doesNotMatch(day[0], /Finish or close them|a review is live/);
  assert.equal(t.status().deferredSince, new Date(T0).toISOString());
});

test('an unknown deferral reason is read as a live review (an older installer sends none)', async () => {
  const t = rig({ install: deferredBy('something-new', 'x') });
  const r = await t.go();
  assert.equal(r.output.action, 'deferred');
  assert.equal(t.status().deferReason, undefined);
});

// R2-F3: a scan that could not look is not a running review: the owner is told what could not be read, not to "finish or close" reviews.
const SCAN_ERR = [{ kind: 'scan-error', detail: 'the repository registry /h/queue-sweep-repos.json cannot be read: Unexpected token n in JSON' }];
const SCAN_DEFERRED = { exitCode: 1, output: { ok: false, error: 'deferred', deferred: true, live: SCAN_ERR, message: 'a review is live' } };

test('R2-F3: normalizeLive carries a length-capped one-line detail; describeLive words a scan-error as "could not check"', () => {
  const [e] = normalizeLive([{ kind: 'scan-error', detail: `bad\n${'x'.repeat(500)}` }]);
  assert.equal(e.kind, 'scan-error');
  assert.ok(e.detail.length <= 200 && !e.detail.includes('\n'), e.detail);
  assert.equal(normalizeLive([{ kind: 'review-lease', repo: 'a/b', pr: 1 }])[0].detail, undefined);
  assert.match(describeLive(normalizeLive(SCAN_ERR)), /could not check.*queue-sweep-repos\.json/);
  assert.doesNotMatch(describeLive(normalizeLive(SCAN_ERR)), /^scan-error$/);
});

test('R2-F3: every blocker a scan-error: the log line, the status and the 24 h notice say it could not check, with the detail, and never "finish or close"', async () => {
  const t = rig({ install: SCAN_DEFERRED });
  const r = await t.go();
  assert.equal(r.output.action, 'deferred');
  assert.match(r.output.message, /could not check for running reviews: .*queue-sweep-repos\.json/);
  assert.doesNotMatch(r.output.message, /waits for a live review/);
  assert.match(t.status().deferredBy[0].detail, /queue-sweep-repos\.json/);
  t.w.clock = T0 + DEFER_NOTICE_MS + 60 * 1000;
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0], /more than 24 hours/);
  assert.match(t.calls.notify[0], /could not check for running reviews: .*queue-sweep-repos\.json/);
  assert.doesNotMatch(t.calls.notify[0], /finish or close/i);
});

test('R2-F3: a scan-error next to a real review keeps the review wording and still shows the detail', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'deferred', deferred: true, live: [...LIVE, ...SCAN_ERR], message: 'x' } } });
  const r = await t.go();
  assert.match(r.output.message, /waits for a live review: acme\/app #12/);
  assert.match(r.output.message, /could not check.*queue-sweep-repos\.json/);
});

// ---- #258 / R4-1: the 24 hour notice is composed by budget; the banner never cuts an instruction; the log and stderr carry everything ------------------

// The text AFTER osascript parsed it: display notification "<escaped>" with title "..." -> the escaped text, un-escaped.
const bannerOf = (spawned) => {
  const arg = spawned.at(-1)[1][1];
  const m = /^display notification "(.*)" with title "[^"]*"$/s.exec(arg);
  assert.ok(m, arg);
  return m[1].replace(/\\(["\\])/g, '$1');
};
// A notifier that writes to a scratch log and records stderr and osascript calls, for a real run of the scheduled update.
function recordingNotify(dir) {
  const seen = { stderr: '', spawned: [] };
  const notify = defaultNotify({ env: { PIPELINE_PRUNE_LOG_DIR: join(dir, 'log') }, platform: 'darwin', stderr: { write: (s) => { seen.stderr += s; } }, spawn: (...a) => seen.spawned.push(a), event: 'pipeline-update' });
  return { seen, notify, log: () => readFileSync(join(dir, 'log', 'pipeline-update-notices.log'), 'utf8') };
}
const deferredWith = (live) => ({ exitCode: 1, output: { ok: false, error: 'deferred', deferred: true, live, message: 'a review is live' } });
// Two runs a day apart, with the default account (the owner's command is the short `node ~/.claude/pipeline/bin/pipeline.mjs update`); -> the rig.
async function dayLater(live, extra = {}, installHome = join(homedir(), '.claude')) {
  const t = rig({ install: deferredWith(live) });
  const go = () => update(['--scheduled', '--json', '--claude-home', installHome], { env: {}, hasClaudeCodeAncestor: () => false, auto: { ...t.auto, ...extra } });
  await go();
  t.w.clock = T0 + DEFER_NOTICE_MS + 60 * 1000;
  await go();
  return t;
}
// A terminal process lease whose end cannot be confirmed (ps cannot answer), in a worktree with a long path, in the scratch lease folder.
async function uncertainLease(dir, worktree) {
  mkdirSync(worktree, { recursive: true });
  const env = LEASE_ENV(dir);
  const base = { env, home: join(dir, 'home'), ancestorPid: null, now: Date.now(), kill: () => {}, jobLive: () => false };
  const holder = { sessionId: 'proc-4242-0123abcd', pid: 4242, pidStart: 'Thu Nov 12 07:00:00 2026' };
  await openOrRenewLease({ worktree, repoId: 'acme/app', pr: 7, command: 'codex-review', processHolder: holder, starts: () => new Map([[4242, holder.pidStart]]), ...base });
  return { file: join(dir, 'leases', `${holder.sessionId}.json`), scan: () => scanOf(dir, [], { ...base, starts: () => null }) };
}

test('R4-1: a job hint that fits is whole in the banner; the log, stderr and the status file carry it too', async () => {
  const dir = scratch();
  const repo = brokenJobRepo(dir, 'wt', 'review');
  const live = scanOf(dir, [repo]);
  const rec = recordingNotify(dir);
  const t = await dayLater(live, { notify: rec.notify });
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX, `${banner.length}: ${banner}`);
  assert.ok(banner.includes(hintOf('review')), banner);
  assert.ok(banner.includes('more than 24 hours'));
  assert.ok(rec.seen.stderr.includes(hintOf('review')) && rec.log().includes(hintOf('review')));
  assert.equal(t.status().deferredBy[0].hint, hintOf('review'));
  assert.doesNotMatch(t.status().deferredBy[0].detail, /remove/);
});

test('R4-1: an uncertain process lease with a real lease path in a long worktree: the banner has the whole pointer (never a cut path); stderr and the log keep the whole delete hint; the status file keeps it', async () => {
  const dir = scratch();
  const worktree = join(dir, 'Claude', 'some-project', '.worktrees', 'agent-a-rather-long-worktree-name-for-this-task-xx-and-some-more-to-be-sure');
  const lease = await uncertainLease(dir, worktree);
  const live = lease.scan();
  assert.equal(live[0].kind, 'scan-error', JSON.stringify(live));
  const hint = `delete ${lease.file} if no pipeline command is running in a terminal`;
  assert.equal(live[0].hint, hint);
  const rec = recordingNotify(dir);
  const statusFile = join(dir, 'update-status.json');
  const t = await dayLater(live, { notify: rec.notify, statusFile });
  // the runnable command is longer than the old bare word: with a head and a status path this long the banner keeps the command (never a cut path)
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX, `${banner.length}: ${banner}`);
  assert.ok(banner.endsWith(`Fix that: run: ${leasesCommand(join(homedir(), '.claude'))}.`), banner);
  // the cause may now name the session (it gets the room the shorter status path used to take); the delete hint's file path is still never in the banner, whole or cut
  assert.ok(!banner.includes('delete ') && !banner.includes('review-leases') && !banner.includes('proc-4242-0123abcd.json'), `no part of the lease path in the banner: ${banner}`);
  assert.ok(banner.includes('could not check for running reviews'), banner);
  assert.ok(rec.seen.stderr.includes(hint), 'stderr carries the whole hint');
  assert.ok(rec.log().includes(hint), 'the notices log carries the whole hint');
  assert.ok(rec.seen.stderr.includes('cannot judge the review lease of proc-4242-0123abcd on '), 'and the cause, naming the session');
  assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).deferredBy[0].hint, hint, 'the status file keeps every hint whole');
});

test('R4-1: the cause takes the rest of the budget and is cut with an ellipsis; the action stays whole; a 24 h notice with no hint keeps its wording', async () => {
  const long = [{ kind: 'scan-error', detail: `the repository registry ${'/very/long/path'.repeat(30)} cannot be read` }];
  const rec = recordingNotify(scratch());
  await dayLater(long, { notify: rec.notify });
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX && banner.includes('…'), banner);
  assert.ok(banner.endsWith('Fix that, or run in your own terminal: node ~/.claude/pipeline/bin/pipeline.mjs update'), banner);
  assert.ok(rec.seen.stderr.includes('/very/long/path'.repeat(10)), 'the log line is the whole cause');
  assert.ok(!rec.seen.stderr.includes('…'), 'and is not cut');
});

test('R4-1: the "deferred N runs" notice is budgeted the same way: a long installer message is cut in the banner only, the command stays whole', async () => {
  const dir = scratch();
  const rec = recordingNotify(dir);
  const message = `another update or a review start holds admission ${'x'.repeat(400)}`;
  const t = rig({ install: deferredBy('admission-busy', message) });
  for (let i = 1; i <= TRANSIENT_RUNS; i += 1) {
    t.w.clock += 60 * 1000;
    await update(['--scheduled', '--json', '--claude-home', join(homedir(), '.claude')], { env: {}, hasClaudeCodeAncestor: () => false, auto: { ...t.auto, notify: rec.notify } });
  }
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX && banner.includes('…'), banner);
  assert.ok(banner.endsWith('run in your own terminal: node ~/.claude/pipeline/bin/pipeline.mjs update'), banner);
  assert.ok(rec.seen.stderr.includes('x'.repeat(400)), 'stderr has the whole message');
});

test('P2-5: appleText cuts the flattened DISPLAY text to BANNER_MAX first and escapes afterwards: quotes and backslashes at the boundary never push a fitting message over the cut', () => {
  assert.equal(BANNER_MAX, 240);
  for (const unit of ['"', '\\', 'a"b\\']) {
    for (let n = BANNER_MAX - 6; n <= BANNER_MAX + 6; n += 1) {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const spawned = [];
      defaultNotify({ env: { PIPELINE_PRUNE_LOG_DIR: scratch() }, platform: 'darwin', stderr: { write() {} }, spawn: (...a) => spawned.push(a) })(text);
      assert.equal(bannerOf(spawned), text.slice(0, BANNER_MAX), `${JSON.stringify(unit)} x ${n}`);
    }
  }
  // control characters are flattened to spaces before the cut
  const spawned = [];
  defaultNotify({ env: { PIPELINE_PRUNE_LOG_DIR: scratch() }, platform: 'darwin', stderr: { write() {} }, spawn: (...a) => spawned.push(a) })('a\nb\tc');
  assert.equal(bannerOf(spawned), 'a b c');
});

test('defaultNotify takes { text, banner }: stderr and the log get the whole text, the banner gets its own (cut) text; a bare string still serves all three', () => {
  const dir = scratch();
  let err = '';
  const spawned = [];
  const notify = defaultNotify({ env: { PIPELINE_PRUNE_LOG_DIR: dir }, platform: 'darwin', stderr: { write: (s) => { err += s; } }, spawn: (...a) => spawned.push(a), event: 'pipeline-update' });
  notify({ text: 'the whole text with "quotes" and every hint', banner: 'short "banner"' });
  assert.equal(err, 'pipeline-update: the whole text with "quotes" and every hint\n');
  assert.match(readFileSync(join(dir, 'pipeline-update-notices.log'), 'utf8'), / the whole text with "quotes" and every hint\n$/);
  assert.equal(bannerOf(spawned), 'short "banner"');
  notify('plain');
  assert.equal(bannerOf(spawned), 'plain');
});

test('R4-1: composeNotice reserves head + action, gives the cause the rest, and steps down hints+tail -> hints -> pointer+tail -> pointer -> pointer without its path; the text is always whole', () => {
  const tail = 'run in your own terminal: node ~/p update';
  const action = (hint, pointer) => ({ lead: 'Finish or close them', hintLead: 'Finish or close them; ', hints: [hint], tail, pointer });
  const head = 'pipeline update to aaaaaaa has been waiting more than 24 hours for live reviews:';
  const cause = 'c'.repeat(400);
  const small = 'remove .review/jobs/x in that worktree if it is stale';
  const big = `delete /${'h'.repeat(140)} if no pipeline command is running in a terminal`;
  const ptr = (n) => `run: node ~/p leases (or see /${'p'.repeat(n)}/s.json)`;
  const run = (hint, pointer, h = head) => {
    const n = composeNotice({ head: h, cause, action: action(hint, pointer) });
    assert.ok(n.banner.length <= BANNER_MAX, `${n.banner.length}`);
    assert.ok(n.text.includes(hint) && n.text.includes(cause) && n.text.endsWith('node ~/p update'), 'text: whole cause, every hint, the tail');
    return n.banner;
  };
  const roomy = composeNotice({ head: 'update to aaaaaaa waits:', cause: 'short cause', action: action(small, ptr(0)) });
  assert.equal(roomy.banner, roomy.text, 'everything fits: banner = text');
  const t1 = composeNotice({ head: 'update to aaaaaaa waits:', cause: 'x'.repeat(120), action: action(small, ptr(0)) });
  assert.ok(t1.banner.endsWith(`; ${small}. Or ${tail}`) && t1.banner.includes('…') && t1.banner.length <= BANNER_MAX, t1.banner);
  const t2 = run(small, ptr(0));
  assert.ok(t2.endsWith(`; ${small}.`) && !t2.includes('Or run in your own') && t2.includes('…'), `hints without the tail: ${t2}`);
  const t3 = run(big, ptr(0));
  assert.ok(t3.endsWith(`${ptr(0)}. Or ${tail}`) && !t3.includes('hhh'), `pointer + tail: ${t3}`);
  const t4 = run(big, ptr(80));
  assert.ok(t4.endsWith(`${ptr(80)}.`) && !t4.includes('Or run in your own'), `the whole pointer: ${t4}`);
  const t5 = composeNotice({ head, cause, action: { ...action(big, ptr(300)), fallbacks: ['run: node ~/p leases', 'see /s.json'] } }).banner;
  assert.ok(t5.length <= BANNER_MAX && t5.endsWith('Finish or close them; run: node ~/p leases.') && !t5.includes('ppp'), `no cut path: ${t5}`);
  assert.ok([t2, t3, t4, t5].every((b) => b.includes('…')), 'the cause is cut with an ellipsis');
});

// ---- R1-B1 / R1-F1: the banner's recovery pointer runs on a standard install, and only leads to `leases` when every hint is a lease ----------------------------------

const oddHome = '/opt/my pipe'; // a configured install dir, short enough for the command to fit
const longJob = 'j'.repeat(150); // a job hint of ~200 characters: too long for the hint tiers, so the banner falls to the pointer
const longWorktree = (dir) => join(dir, 'Claude', 'some-project', '.worktrees', 'agent-a-rather-long-worktree-name-for-this-task-xx-and-some-more-to-be-sure');

test('R1-B1: leasesCommand spells the full node command like ownerCommand: the default home as ~/.claude, another install dir quoted (there is no bare `pipeline` executable)', () => {
  const user = '/Users/x';
  assert.equal(leasesCommand(join(user, '.claude'), user), 'node ~/.claude/pipeline/bin/pipeline.mjs leases');
  assert.equal(leasesCommand("/opt/my 'pipe'/c", user), "node '/opt/my '\\''pipe'\\''/c/pipeline/bin/pipeline.mjs' leases");
});

test('R1-B1: the 24 h banner for an uncertain lease points at the full node command of the CONFIGURED install dir and still fits BANNER_MAX', async () => {
  const dir = scratch();
  const lease = await uncertainLease(dir, longWorktree(dir));
  const rec = recordingNotify(dir);
  const statusFile = join(dir, 'update-status.json');
  const home = oddHome;
  await dayLater(lease.scan(), { notify: rec.notify, statusFile }, home);
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX, `${banner.length}: ${banner}`);
  assert.equal(leasesCommand(home), "node '/opt/my pipe/pipeline/bin/pipeline.mjs' leases");
  assert.ok(banner.endsWith("Fix that: run: node '/opt/my pipe/pipeline/bin/pipeline.mjs' leases."), banner);
  assert.doesNotMatch(banner, /run: pipeline leases/);
});

test('R1-B1: the shortest fallbacks keep a runnable command, then the status file path, inside BANNER_MAX', () => {
  const head = 'pipeline update to aaaaaaa has been waiting more than 24 hours for live reviews:';
  const cmd = leasesCommand('/Users/x/.claude', '/Users/x');
  const hint = `delete /${'h'.repeat(140)} if no pipeline command is running in a terminal`;
  const status = '/Users/x/.claude/pipeline-state/update-status.json';
  const base = { lead: 'Finish or close them', hintLead: 'Finish or close them; ', hints: [hint], tail: `run in your own terminal: ${cmd}` };
  // the pointer (command + a long status path) does not fit; the command alone does
  const long = composeNotice({ head, cause: 'c'.repeat(300), action: { ...base, pointer: `run: ${cmd} (or see /${'p'.repeat(200)}.json)`, fallbacks: [`run: ${cmd}`, `see ${status}`] } });
  assert.ok(long.banner.length <= BANNER_MAX && long.banner.endsWith(`Finish or close them; run: ${cmd}.`), long.banner);
  assert.ok(!/ppp/.test(long.banner), 'no cut path');
  // a command too long for the budget (a long install dir): the status file path is the last fallback
  const hugeCmd = `node '/${'d'.repeat(180)}/pipeline/bin/pipeline.mjs' leases`;
  const last = composeNotice({ head, cause: 'c'.repeat(300), action: { ...base, pointer: `run: ${hugeCmd} (or see ${status})`, fallbacks: [`run: ${hugeCmd}`, `see ${status}`] } });
  assert.ok(last.banner.length <= BANNER_MAX && last.banner.endsWith(`Finish or close them; see ${status}.`), last.banner);
  assert.ok(last.text.includes('c'.repeat(300)) && last.text.includes(hint), 'the log text stays whole');
});

test('R1-F1: an unreadable JOB record is not a lease: the banner points at the status file, not at `leases`; the log keeps the whole hint', async () => {
  const dir = scratch();
  const live = scanOf(dir, [brokenJobRepo(dir, 'wt', longJob)]);
  assert.equal(live[0].kind, 'job', JSON.stringify(live));
  const rec = recordingNotify(dir);
  const statusFile = join(dir, 'update-status.json');
  await dayLater(live, { notify: rec.notify, statusFile });
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX, `${banner.length}: ${banner}`);
  assert.ok(banner.includes(`see ${statusFile}`), banner);
  assert.doesNotMatch(banner, /leases/);
  assert.ok(rec.seen.stderr.includes(hintOf(longJob)) && rec.log().includes(hintOf(longJob)), 'the whole hint is in the log');
});

test('R1-F1: a job hint and a lease hint together: the pointer leads with the status file and `leases` is not offered for the lot', async () => {
  const dir = scratch();
  const lease = await uncertainLease(dir, longWorktree(dir));
  const base = { env: LEASE_ENV(dir), home: join(dir, 'home'), ancestorPid: null, now: Date.now(), kill: () => {}, jobLive: () => false, starts: () => null };
  const live = scanOf(dir, [brokenJobRepo(dir, 'wt', longJob)], base);
  assert.deepEqual([...new Set(live.map((e) => e.kind))].sort(), ['job', 'scan-error'], JSON.stringify(live));
  const rec = recordingNotify(dir);
  const statusFile = join(dir, 'update-status.json');
  await dayLater(live, { notify: rec.notify, statusFile });
  const banner = bannerOf(rec.seen.spawned);
  assert.ok(banner.length <= BANNER_MAX, `${banner.length}: ${banner}`);
  assert.ok(banner.includes(`see ${statusFile}`), banner);
  assert.doesNotMatch(banner, /run: .*leases/);
  assert.ok(rec.seen.stderr.includes(lease.file) && rec.seen.stderr.includes(hintOf(longJob)), 'the log has both hints');
});
