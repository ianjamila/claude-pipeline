// Why: `update --scheduled` runs unattended every few minutes, so what it must NOT do matters most: no install when current,
// no touching a modified install, no downgrade, and no push on a quiet run. Every dependency is injected (ctx.auto): no network,
// no real install, no real push. The dedupe state lives in a temp file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update, meta } from '../pipeline/commands/update.mjs';
import { planPush, markNotified, ownerEvent, readState, TRANSIENT_RUNS } from '../pipeline/lib/auto-update.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'cp-upd-sched-')); made.push(d); return d; };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const pristine = (sourceSha = OLD) => ({ stamp: `1.0+${sourceSha.slice(0, 7)}`, sourceSha, complete: true, sourceDirty: false, modified: [], missing: [], extra: [], scanError: [] });

// A rig: the state of the world (main, installed identity, relation, install result) is mutable between runs.
function rig(over = {}) {
  const dir = scratch();
  const w = { main: { ok: true, sha: SHA_A, via: 'gh' }, id: pristine(), relation: { status: 'ahead' }, install: { exitCode: 0, output: { ok: true, before: '1.0+cccccc', after: '1.0+aaaaaaa', main: { sha: SHA_A } } }, ...over };
  const calls = { install: 0, notify: [] };
  let n = 0;
  const auto = {
    mainSha: () => w.main,
    installedIdentity: () => w.id,
    relate: () => w.relation,
    performUpdate: async () => { calls.install += 1; return w.install; },
    notify: async (ev) => { calls.notify.push(ev); return { sent: true }; },
    now: () => new Date(Date.UTC(2026, 9, 14, 0, n++, 0)),
    stateFile: join(dir, 'state.json'),
  };
  const go = (extra = {}) => update(['--scheduled', '--json', '--claude-home', join(dir, 'home')], { env: { PIPELINE_PRUNE_LOG_DIR: dir }, hasClaudeCodeAncestor: () => false, auto: { ...auto, ...extra } });
  return { w, calls, go, auto, dir };
}

test('meta documents --scheduled', () => {
  assert.match(meta.usage, /--scheduled/);
});

test('--scheduled and --check cannot be combined', async () => {
  await assert.rejects(update(['--scheduled', '--check'], { env: {} }), /cannot be combined/);
});

test('--scheduled refuses inside Claude Code like a manual update', async () => {
  const r = await update(['--scheduled', '--json'], { env: { CLAUDECODE: '1' }, hasClaudeCodeAncestor: () => false });
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.error, 'refused');
});

test('identical and clean: action none, no install, no push, compact output', async () => {
  const t = rig({ relation: { status: 'identical' } });
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.equal(r.compact, true);
  assert.deepEqual([r.output.ok, r.output.mode, r.output.action], [true, 'scheduled', 'none']);
  assert.equal(t.calls.install, 0);
  assert.equal(t.calls.notify.length, 0);
});

test('only the quiet run is silent: emit prints nothing for action none, one compact line for every other action', async () => {
  const { emit } = await import('../pipeline/lib/cli.mjs');
  const printed = (result) => { let out = ''; const code = emit(result, { stdout: { write: (s) => { out += s; } } }); return { out, code }; };
  const none = await rig({ relation: { status: 'identical' } }).go();
  assert.equal(none.silent, true);
  assert.deepEqual(printed(none), { out: '', code: 0 });
  const updated = await rig().go();
  assert.equal(updated.output.action, 'updated');
  assert.equal(updated.silent, undefined);
  const skipped = await rig({ id: { ...pristine(), modified: ['x'] } }).go();
  const failed = await rig({ main: { ok: false, reason: 'offline' } }).go();
  for (const r of [updated, skipped, failed]) {
    const { out } = printed(r);
    assert.equal(out.trimEnd().split('\n').length, 1);
    assert.equal(JSON.parse(out).mode, 'scheduled');
  }
});

test('a modified install is skipped (never overwritten) and the owner is pushed once; a second run pushes nothing', async () => {
  const t = rig({ id: { ...pristine(), modified: ['pipeline/lib/x.mjs'] } });
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.output.action, r.output.reason], ['skipped', 'modified']);
  assert.equal(t.calls.install, 0);
  assert.equal(t.calls.notify.length, 1);
  assert.equal(t.calls.notify[0].event, 'pipeline-update');
  assert.equal(t.calls.notify[0].title, 'Pipeline auto-update paused');
  assert.match(t.calls.notify[0].action, /manual update in your own terminal/);
  assert.equal(t.calls.notify[0].head, SHA_A);
  const again = await t.go();
  assert.equal(again.output.action, 'skipped');
  assert.equal(t.calls.notify.length, 1, 'same (reason, main sha): no second push');
  t.w.main = { ok: true, sha: SHA_B, via: 'gh' };
  await t.go();
  assert.equal(t.calls.notify.length, 2, 'a new main sha is a new key');
});

test('an install that is ahead of or diverged from main is skipped as a downgrade', async () => {
  for (const status of ['behind', 'diverged']) {
    const t = rig({ relation: { status } });
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.action, r.output.reason], [0, 'skipped', 'downgrade']);
    assert.equal(t.calls.install, 0);
    assert.equal(t.calls.notify.length, 1);
  }
});

test('an install that records no source commit, or nothing installed, is left alone', async () => {
  for (const id of [null, { ...pristine(), sourceSha: null }]) {
    const t = rig({ id });
    const r = await t.go();
    assert.deepEqual([r.output.action, r.output.reason], ['skipped', 'modified']);
    assert.equal(t.calls.install, 0);
  }
});

test('behind and the install works: action updated with before/after, no push', async () => {
  const t = rig();
  const r = await t.go();
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.output.action, r.output.before, r.output.after], ['updated', '1.0+cccccc', '1.0+aaaaaaa']);
  assert.equal(t.calls.install, 1);
  assert.equal(t.calls.notify.length, 0);
});

test('install-failed: exit 1 with the error code and one push; same main sha again is quiet, a new main sha pushes again', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } } });
  const r = await t.go();
  assert.deepEqual([r.exitCode, r.output.ok, r.output.error, r.output.action], [1, false, 'install-failed', 'failed']);
  assert.equal(t.calls.notify.length, 1);
  assert.equal(t.calls.notify[0].title, 'Pipeline auto-update failed');
  assert.match(t.calls.notify[0].action, /read its error/);
  assert.equal((await t.go()).exitCode, 1);
  assert.equal(t.calls.notify.length, 1);
  t.w.main = { ok: true, sha: SHA_B, via: 'gh' };
  await t.go();
  assert.equal(t.calls.notify.length, 2);
});

test('every existing failure code passes through with exit 1', async () => {
  for (const error of ['fetch-failed', 'installer-too-old', 'check-failed', 'unverified', 'install-failed']) {
    const t = rig({ install: { exitCode: 1, output: { ok: false, error, message: 'm' } } });
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.error], [1, error]);
    assert.equal(t.calls.notify.length, 1);
  }
});

test('a busy install lock is transient: runs 1 and 2 push nothing, run 3 pushes once, run 4 is quiet', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'another install is running in /h. Wait for it to finish' } } });
  for (let i = 1; i <= TRANSIENT_RUNS; i += 1) {
    const r = await t.go();
    assert.deepEqual([r.exitCode, r.output.error], [1, 'install-failed']);
    assert.equal(t.calls.notify.length, i < TRANSIENT_RUNS ? 0 : 1, `run ${i}`);
  }
  await t.go();
  assert.equal(t.calls.notify.length, 1);
});

test('an unresolved upstream (network) is transient too; a failed compare as well', async () => {
  const t = rig({ main: { ok: false, reason: 'offline' } });
  for (let i = 0; i < 2; i += 1) assert.equal((await t.go()).output.error, 'upstream-unresolved');
  assert.equal(t.calls.notify.length, 0);
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  const c = rig({ relation: { status: 'unresolved', reason: 'rate limited' } });
  const r = await c.go();
  assert.deepEqual([r.exitCode, r.output.error], [1, 'upstream-unresolved']);
  assert.equal(c.calls.notify.length, 0);
});

test('a transient streak is broken by a good run: it takes three more in a row to push', async () => {
  const t = rig({ main: { ok: false, reason: 'offline' } });
  await t.go(); await t.go();
  t.w.main = { ok: true, sha: SHA_A, via: 'gh' };
  t.w.relation = { status: 'identical' };
  await t.go();
  t.w.main = { ok: false, reason: 'offline' };
  await t.go(); await t.go();
  assert.equal(t.calls.notify.length, 0);
  await t.go();
  assert.equal(t.calls.notify.length, 1);
});

test('a success after a failure clears the dedupe state: the same failure pushes again', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } } });
  await t.go();
  assert.equal(t.calls.notify.length, 1);
  assert.equal(existsSync(t.auto.stateFile), true);
  t.w.install = { exitCode: 0, output: { ok: true, before: 'x', after: 'y', main: { sha: SHA_A } } };
  assert.equal((await t.go()).output.action, 'updated');
  assert.equal(existsSync(t.auto.stateFile), false, 'state cleared');
  t.w.install = { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } };
  await t.go();
  assert.equal(t.calls.notify.length, 2);
  assert.notEqual(t.calls.notify[0].cause, t.calls.notify[1].cause, 'a new episode is a new notify ledger key');
});

test('a push that was not delivered is retried next run with the same episode; a throwing notify never changes the exit code', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } } });
  let fail = true;
  const notify = async (ev) => { t.calls.notify.push(ev); if (fail) throw new Error('ntfy down'); return { sent: true }; };
  const r = await t.go({ notify });
  assert.deepEqual([r.exitCode, r.output.notify.sent], [1, false]);
  fail = false;
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 2);
  assert.equal(t.calls.notify[0].cause, t.calls.notify[1].cause);
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 2, 'delivered now: quiet');
});

test('notify "duplicate" (the ledger already has it) counts as delivered', async () => {
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } } });
  const notify = async (ev) => { t.calls.notify.push(ev); return { sent: false, reason: 'duplicate' }; };
  await t.go({ notify });
  await t.go({ notify });
  assert.equal(t.calls.notify.length, 1);
});

test('planPush: pure state transitions, and a corrupt state file reads as empty', () => {
  const prob = { reason: 'install-failed', sha: SHA_A, transient: false };
  const p1 = planPush({}, prob, { nowIso: 't1' });
  assert.deepEqual(p1.push, { key: `install-failed:${SHA_A}`, episode: 't1' });
  const s1 = markNotified(p1.state, p1.push);
  assert.equal(s1.notified, p1.push.key);
  assert.equal(s1.pending, undefined);
  assert.equal(planPush(s1, prob, { nowIso: 't2' }).push, null);
  assert.deepEqual(planPush(s1, null, { nowIso: 't2' }), { push: null, state: {} });
  const dir = scratch();
  assert.deepEqual(readState(join(dir, 'missing.json')), {});
  assert.deepEqual(readState('x', { readFile: () => '[1]' }), {});
  assert.deepEqual(readState('x', { readFile: () => '{nope' }), {});
});

test('ownerEvent: the action tells the owner the one thing to do and the cause carries the episode', () => {
  const push = { key: 'k', episode: 'e' };
  const failed = ownerEvent({ reason: 'fetch-failed', sha: SHA_A, message: 'git fetch timed out' }, push);
  assert.match(failed.action, /Run the manual update in your own terminal and read its error/);
  assert.match(failed.action, /git fetch timed out/);
  assert.equal(failed.cause, 'k@e');
  assert.equal(failed.pr, null);
  assert.match(ownerEvent({ reason: 'modified', skipped: 'modified', sha: SHA_A }, push).title, /paused/);
});

test('the state file is written next to the worktrees logs by default (PIPELINE_PRUNE_LOG_DIR)', async () => {
  const dir = scratch();
  const t = rig({ install: { exitCode: 1, output: { ok: false, error: 'install-failed', message: 'boom' } } });
  const auto = { ...t.auto };
  delete auto.stateFile;
  await update(['--scheduled', '--json', '--claude-home', join(dir, 'h')], { env: { PIPELINE_PRUNE_LOG_DIR: dir }, hasClaudeCodeAncestor: () => false, auto });
  assert.equal(JSON.parse(readFileSync(join(dir, 'auto-update-state.json'), 'utf8')).notified, `install-failed:${SHA_A}`);
});
