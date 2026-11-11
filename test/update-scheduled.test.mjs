// Why: `update --scheduled` runs unattended every few minutes and can replace the guard hooks, so what it must NOT do matters most: no install
// when current, no touching a modified / incomplete / ahead / diverged install, no install while a review is live, no retry of a version that did
// not verify, and no notification spam. Every dependency is injected (ctx.auto): no network, no real install, no real notification, and the
// status / bookkeeping files live in a scratch account home. The real download + installer-flag path is in update-scheduled-installer.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update, meta } from '../pipeline/commands/update.mjs';
import { emit } from '../pipeline/lib/cli.mjs';
import {
  DEFER_NOTICE_MS, STATE_FILE, STATUS_FILE, TRANSIENT_RUNS, describeLive, normalizeLive, ownerCommand, pipelineStateDir,
} from '../pipeline/lib/auto-update.mjs';
import { defaultNotify } from '../pipeline/lib/queue-sweep.mjs';

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
  const w = { main: { ok: true, sha: SHA_A, via: 'gh' }, id: pristine(), relation: { status: 'ahead' }, install: OK_INSTALL, clock: T0, ...over };
  const calls = { install: [], relate: 0, notify: [] };
  const auto = {
    mainSha: () => w.main,
    installedIdentity: () => w.id,
    relate: () => { calls.relate += 1; return w.relation; },
    performUpdate: async (args) => { calls.install.push(args); return w.install; },
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
