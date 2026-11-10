// The Fable floor registry (plan 2026-11-10, A1/A2/A4b): model-id parsing, floor = max(constant, registry) capped by a hold, fail-closed reads,
// raise-only atomic writes, the machine-wide lock in the registry folder, and the checkout-only folder override.
// Every test works in a temp folder (an injected `dir` or `home`): the real ~/.claude is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOW_MAX, FLOOR_REL, HISTORY_MAX, MIN_FABLE, checkFloor, compareVersions, floorDir, parseModelId, raiseFloor, readFloor, readReviewGate, reReviewThreshold, resetFloor, withFloorLock,
} from '../pipeline/lib/model-floor.mjs';
import { tryAcquire } from '../pipeline/lib/locks.mjs';
import { readApprovals } from '../pipeline/hooks/lib/owner-go.mjs';

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-floor-'));
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  return dir;
};
const reg = (dir) => join(dir, 'fable.json');
const writeReg = (dir, obj) => { mkdirSync(dir, { recursive: true }); writeFileSync(reg(dir), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const good = (extra = {}) => ({ version: 1, newest: 'claude-fable-5-3', provenAt: '2026-11-10T00:00:00.000Z', claudeCode: '2.1.400', transcript: '/t.jsonl', history: [], hold: null, ...extra });
const NOW = Date.parse('2026-11-11T08:00:00Z');

// ---- parseModelId / compareVersions ----
test('parseModelId: family, major, minor; a date suffix is stripped and never read as a minor', () => {
  assert.deepEqual(parseModelId('claude-fable-5-2'), { family: 'fable', major: 5, minor: 2 });
  assert.deepEqual(parseModelId('claude-fable-5-2-20261110'), { family: 'fable', major: 5, minor: 2 });
  assert.deepEqual(parseModelId('claude-fable-5'), { family: 'fable', major: 5, minor: 0 });
  assert.deepEqual(parseModelId('claude-opus-4-20250514'), { family: 'opus', major: 4, minor: 0 });
  assert.deepEqual(parseModelId('claude-sonnet-4-6-20260101'), { family: 'sonnet', major: 4, minor: 6 });
  assert.deepEqual(parseModelId('claude-haiku-5-5'), { family: 'haiku', major: 5, minor: 5 });
  assert.deepEqual(parseModelId('claude-mythos-1'), { family: 'mythos', major: 1, minor: 0 });
  assert.deepEqual(parseModelId('claude-fable-10-12'), { family: 'fable', major: 10, minor: 12 });
});

test('parseModelId is null for an unknown family and for garbage', () => {
  for (const bad of ['claude-gemini-1-2', 'claude-fable', 'claude-fable-', 'claude-fable-x-2', 'claude-fable-5-x', 'claude-fable-5-2-2026', 'claude-fable-5-2-202611100',
    'claude-fable-5-123456789', 'claude-fable-5-2-', 'claude-fable-5-2 ', ' claude-fable-5-2', 'CLAUDE-FABLE-5-2', 'fable', '', '<synthetic>', null, undefined, 5, {}]) {
    assert.equal(parseModelId(bad), null, String(bad));
  }
});

test('compareVersions orders by major then minor', () => {
  const v = (id) => parseModelId(id);
  assert.equal(compareVersions(v('claude-fable-5-1'), v('claude-fable-5-2')), -1);
  assert.equal(compareVersions(v('claude-fable-5-2'), v('claude-fable-5-2-20261110')), 0);
  assert.equal(compareVersions(v('claude-fable-5-10'), v('claude-fable-5-9')), 1);
  assert.equal(compareVersions(v('claude-fable-6'), v('claude-fable-5-9')), 1);
  assert.equal(compareVersions(v('claude-fable-5'), v('claude-fable-5-0')), 0);
});

test('MIN_FABLE is a parseable Fable id', () => {
  assert.equal(MIN_FABLE, 'claude-fable-5-2');
  assert.equal(parseModelId(MIN_FABLE).family, 'fable');
});

// ---- readFloor: constant vs registry ----
test('an absent registry means the code constant', (t) => {
  const dir = join(tmp(t), 'model-floor');
  const r = readFloor({ dir });
  assert.equal(r.ok, true);
  assert.equal(r.floor, MIN_FABLE);
  assert.equal(r.registry, null);
  assert.equal(existsSync(dir), false, 'a read creates nothing');
});

test('floor = max(constant, registry): a newer registry wins, an older one never lowers the constant', (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, good({ newest: 'claude-fable-5-3' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-3');
  writeReg(dir, good({ newest: 'claude-fable-5-1' }));
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
  writeReg(dir, good({ newest: 'claude-fable-5-2-20261110' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-2', 'canonical, date stripped');
  writeReg(dir, good({ newest: 'claude-fable-6' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-6');
});

test('a hold caps the floor, even below the constant', (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, good({ newest: 'claude-fable-5-4', hold: 'claude-fable-5-3' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-3');
  writeReg(dir, good({ newest: 'claude-fable-5-2', hold: 'claude-fable-5-1' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-1', 'an alias rollback: the hold is the ceiling, the constant does not override it');
  writeReg(dir, good({ newest: 'claude-fable-5-3', hold: 'claude-fable-5-9' }));
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-3', 'a hold above the floor changes nothing');
});

// ---- readFloor: fail closed ----
test('corrupt JSON, wrong schema, oversized and non-file registries fail closed with the owner path in the message', (t) => {
  const dir = join(tmp(t), 'f');
  const bad = [
    '{not json', '', '[]', 'null', '"x"',
    good({ version: 2 }), good({ version: undefined }), good({ newest: 'claude-opus-4-6' }), good({ newest: 'garbage' }), good({ newest: undefined }),
    good({ history: 'x' }), good({ history: [{ model: 'nope' }] }), good({ history: Array.from({ length: HISTORY_MAX + 1 }, () => ({ model: 'claude-fable-5-3' })) }),
    good({ hold: 'claude-sonnet-4-6' }), good({ hold: 7 }), good({ provenAt: 5 }), good({ claudeCode: {} }),
  ];
  for (const b of bad) {
    writeReg(dir, b);
    const r = readFloor({ dir });
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.equal(r.error, 'model-floor-unreadable');
    assert.equal(r.floor, null);
    assert.match(r.message, /fable\.json/);
    assert.match(r.message, /the owner runs `pipeline model-floor reset`|owner runs `pipeline model-floor reset`/);
  }
  writeReg(dir, 'x'.repeat(70 * 1024));
  assert.equal(readFloor({ dir }).ok, false);
  rmSync(reg(dir));
  mkdirSync(reg(dir));
  assert.equal(readFloor({ dir }).ok, false, 'a directory where the file belongs');
});

test('a symlinked registry file and an unreadable one fail closed', (t) => {
  const root = tmp(t);
  const dir = join(root, 'f');
  mkdirSync(dir);
  writeFileSync(join(root, 'elsewhere.json'), JSON.stringify(good()));
  symlinkSync(join(root, 'elsewhere.json'), reg(dir));
  assert.equal(readFloor({ dir }).ok, false);
  rmSync(reg(dir));
  writeReg(dir, good());
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(reg(dir), 0o000);
    const r = readFloor({ dir });
    assert.equal(r.ok, false);
    assert.match(r.message, /EACCES/);
  }
});

// ---- checkFloor ----
test('checkFloor judges only Fable ids: older, unparseable, equal, newer, and everything else ignored', () => {
  const floor = 'claude-fable-5-2';
  assert.deepEqual(checkFloor({ models: ['claude-fable-5-2'], floor }), { ok: true, older: [], unparseable: [] });
  assert.deepEqual(checkFloor({ models: ['claude-fable-5-3', 'claude-fable-5-2-20261110', 'claude-fable-6'], floor }).ok, true);
  assert.deepEqual(checkFloor({ models: ['claude-fable-5-1'], floor }), { ok: false, older: ['claude-fable-5-1'], unparseable: [] });
  assert.deepEqual(checkFloor({ models: ['claude-fable-5', 'claude-fable-5-1-20260101', 'claude-fable-5-1', 'claude-fable-5-2'], floor }).older, ['claude-fable-5', 'claude-fable-5-1-20260101', 'claude-fable-5-1'], 'mixed transcript: one old line fails; duplicates listed once');
  const weird = checkFloor({ models: ['claude-fable-x', 'claude-fable-5-2-beta', 'claude-fable-5-3'], floor });
  assert.equal(weird.ok, false);
  assert.deepEqual(weird.unparseable, ['claude-fable-x', 'claude-fable-5-2-beta']);
  // other families, synthetic markers and junk are not this check's business
  assert.equal(checkFloor({ models: ['claude-sonnet-4-6', 'claude-opus-4-1', 'claude-haiku-4-5', '<synthetic>', 'gpt-5', '', null, 7], floor }).ok, true);
  assert.equal(checkFloor({ models: [], floor }).ok, true);
  assert.equal(checkFloor({ models: undefined, floor }).ok, true);
  assert.throws(() => checkFloor({ models: [], floor: 'claude-opus-4-6' }), { code: 'model-floor-bad-floor' });
});

// ---- raiseFloor ----
test('raiseFloor writes a newer model once, with provenance, and is a no-op for an equal or older one', (t) => {
  const dir = join(tmp(t), 'model-floor');
  const a = raiseFloor({ dir, model: 'claude-fable-5-3-20261111', claudeCode: '2.1.400', transcript: '/t/a.jsonl', now: NOW });
  assert.equal(a.raised, true);
  assert.equal(a.floor, 'claude-fable-5-3');
  const stored = JSON.parse(readFileSync(reg(dir), 'utf8'));
  assert.deepEqual(stored, {
    version: 1, newest: 'claude-fable-5-3', provenAt: '2026-11-11T08:00:00.000Z', claudeCode: '2.1.400', transcript: '/t/a.jsonl',
    history: [{ model: 'claude-fable-5-3', at: '2026-11-11T08:00:00.000Z', claudeCode: '2.1.400', transcript: '/t/a.jsonl' }], hold: null,
  });
  assert.deepEqual(readdirSync(dir), ['fable.json'], 'no tmp file left behind');
  const before = readFileSync(reg(dir), 'utf8');
  for (const model of ['claude-fable-5-3', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5']) {
    const r = raiseFloor({ dir, model, now: NOW + 1 });
    assert.deepEqual([r.raised, r.reason, r.floor], [false, 'not-newer', 'claude-fable-5-3'], model);
  }
  assert.equal(readFileSync(reg(dir), 'utf8'), before, 'raise-only: nothing rewritten');
});

test('raiseFloor on an absent registry compares against the constant', (t) => {
  const dir = join(tmp(t), 'f');
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-2' }).raised, false, 'equal to the constant');
  assert.equal(existsSync(reg(dir)), false);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-1' }).raised, false);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-4' }).raised, true);
});

test('raiseFloor keeps only the last 10 raises and refuses a non-Fable id', (t) => {
  const dir = join(tmp(t), 'f');
  for (let minor = 3; minor <= 16; minor++) assert.equal(raiseFloor({ dir, model: `claude-fable-5-${minor}`, now: NOW + minor }).raised, true);
  const stored = JSON.parse(readFileSync(reg(dir), 'utf8'));
  assert.equal(stored.history.length, HISTORY_MAX);
  assert.equal(stored.history[0].model, 'claude-fable-5-7');
  assert.equal(stored.history.at(-1).model, 'claude-fable-5-16');
  assert.equal(readFloor({ dir }).ok, true, 'a full history still reads');
  for (const model of ['claude-sonnet-5-5', 'claude-fable-x', '', undefined]) assert.throws(() => raiseFloor({ dir, model }), { code: 'model-floor-bad-model' });
});

test('raiseFloor refuses to go above a hold and leaves the file alone', (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, good({ newest: 'claude-fable-5-2', hold: 'claude-fable-5-3' }));
  const before = readFileSync(reg(dir), 'utf8');
  const above = raiseFloor({ dir, model: 'claude-fable-5-4' });
  assert.deepEqual([above.raised, above.reason, above.hold, above.floor], [false, 'above-hold', 'claude-fable-5-3', 'claude-fable-5-2']);
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-3', now: NOW }).raised, true, 'up to the hold is fine');
  assert.equal(JSON.parse(readFileSync(reg(dir), 'utf8')).hold, 'claude-fable-5-3', 'the hold survives a raise');
});

test('raiseFloor never overwrites an unreadable registry', (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, '{broken');
  assert.throws(() => raiseFloor({ dir, model: 'claude-fable-6' }), { code: 'model-floor-unreadable', message: /pipeline model-floor reset/ });
  assert.equal(readFileSync(reg(dir), 'utf8'), '{broken');
});

test('a write failure throws model-floor-unwritable and leaves the old registry and no tmp file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, good({ newest: 'claude-fable-5-3' }));
  const before = readFileSync(reg(dir), 'utf8');
  chmodSync(dir, 0o500);
  assert.throws(() => raiseFloor({ dir, model: 'claude-fable-5-4' }), { code: 'model-floor-unwritable' });
  chmodSync(dir, 0o700);
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['fable.json']);
});

// ---- the folder: owner-go's real-directory chain ----
test('the account folder is <home>/.claude/pipeline-state/owner-go/model-floor and is created through the real-directory chain', (t) => {
  const home = tmp(t);
  assert.equal(FLOOR_REL, '.claude/pipeline-state/owner-go/model-floor');
  assert.equal(floorDir({ home, env: {} }), join(home, '.claude', 'pipeline-state', 'owner-go', 'model-floor'));
  assert.equal(raiseFloor({ home, env: {}, model: 'claude-fable-5-3', now: NOW }).raised, true);
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'pipeline-state', 'owner-go', 'model-floor', 'fable.json'), 'utf8')).newest, 'claude-fable-5-3');
  assert.equal(readFloor({ home, env: {} }).floor, 'claude-fable-5-3');
});

test('a symlink anywhere in the chain makes the write fail closed instead of following it', { skip: process.platform === 'win32' }, async (t) => {
  const home = tmp(t);
  const elsewhere = tmp(t);
  mkdirSync(join(home, '.claude'));
  symlinkSync(elsewhere, join(home, '.claude', 'pipeline-state'));
  assert.throws(() => raiseFloor({ home, env: {}, model: 'claude-fable-5-3' }), { code: 'model-floor-unwritable' });
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  await assert.rejects(withFloorLock({ home, env: {}, waitMs: 50 }, () => 'x'), { code: 'model-floor-unwritable' });
  // the leaf folder itself a symlink
  const home2 = tmp(t);
  mkdirSync(join(home2, '.claude', 'pipeline-state', 'owner-go'), { recursive: true });
  symlinkSync(elsewhere, join(home2, '.claude', 'pipeline-state', 'owner-go', 'model-floor'));
  assert.throws(() => raiseFloor({ home: home2, env: {}, model: 'claude-fable-5-3' }), { code: 'model-floor-unwritable' });
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('the owner-go readers do not read the model-floor subdirectory as a record', (t) => {
  const home = tmp(t);
  const ownerGo = join(home, '.claude', 'pipeline-state', 'owner-go');
  mkdirSync(ownerGo, { recursive: true });
  const record = (session) => JSON.stringify({ v: 1, session, ts: new Date().toISOString(), prs: [7], requests: [] });
  writeFileSync(join(ownerGo, 'sess-a.jsonl'), `${record('sess-a')}\n`);
  assert.deepEqual(readApprovals({ home }).map((a) => a.session), ['sess-a']);
  // the floor writes its folder, registry and lock there, plus a record-shaped file inside the subfolder: still invisible
  raiseFloor({ home, env: {}, model: 'claude-fable-5-3', now: NOW });
  writeFileSync(join(ownerGo, 'model-floor', 'sess-b.jsonl'), `${record('sess-b')}\n`);
  assert.equal(existsSync(join(ownerGo, 'model-floor', 'fable.json')), true);
  assert.deepEqual(readApprovals({ home }).map((a) => a.session), ['sess-a']);
  assert.deepEqual(readApprovals({ home, session: 'model-floor' }), []);
});

// ---- the lock ----
test('withFloorLock keeps its lock file in the registry folder and runs fn holding it', async (t) => {
  const dir = join(tmp(t), 'model-floor');
  const seen = await withFloorLock({ dir }, ({ dir: d }) => {
    assert.equal(d, dir);
    assert.equal(existsSync(join(dir, 'model-floor.lock', 'owner.json')), true);
    return 'done';
  });
  assert.equal(seen, 'done');
  assert.equal(existsSync(join(dir, 'model-floor.lock')), false, 'released');
});

test('withFloorLock releases when fn throws, and serialises two holders', async (t) => {
  const dir = join(tmp(t), 'f');
  await assert.rejects(withFloorLock({ dir }, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(join(dir, 'model-floor.lock')), false);
  const order = [];
  const first = withFloorLock({ dir, pollMs: 10 }, async () => { order.push('a-in'); await new Promise((r) => setTimeout(r, 120)); order.push('a-out'); });
  await new Promise((r) => setTimeout(r, 30));
  const second = withFloorLock({ dir, pollMs: 10 }, () => { order.push('b-in'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-in', 'a-out', 'b-in']);
});

test('a lock held longer than the wait throws model-floor-busy', async (t) => {
  const dir = join(tmp(t), 'f');
  mkdirSync(dir, { recursive: true });
  const held = tryAcquire('model-floor', { dir, machineId: null });
  assert.equal(held.acquired, true);
  const started = Date.now();
  await assert.rejects(withFloorLock({ dir, waitMs: 150, pollMs: 20 }, () => assert.fail('must not run')), (err) => {
    assert.equal(err.code, 'model-floor-busy');
    assert.match(err.message, /model-floor reset --clear-lock/);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
  assert.equal(existsSync(join(dir, 'model-floor.lock')), true, 'the holder keeps its lock');
});

test('the lock does not use PIPELINE_LOCK_DIR or the default lock dir', async (t) => {
  const dir = join(tmp(t), 'f');
  const other = tmp(t);
  const saved = process.env.PIPELINE_LOCK_DIR;
  process.env.PIPELINE_LOCK_DIR = other;
  t.after(() => { if (saved === undefined) delete process.env.PIPELINE_LOCK_DIR; else process.env.PIPELINE_LOCK_DIR = saved; });
  await withFloorLock({ dir }, () => { assert.equal(existsSync(join(dir, 'model-floor.lock')), true); });
  assert.deepEqual(readdirSync(other), []);
});

// ---- resetFloor ----
test('resetFloor rewrites to the constant, dropping the raises', async (t) => {
  const dir = join(tmp(t), 'f');
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const r = await resetFloor({ dir, now: NOW });
  assert.equal(r.floor, MIN_FABLE);
  assert.deepEqual(JSON.parse(readFileSync(reg(dir), 'utf8')), { version: 1, newest: MIN_FABLE, provenAt: null, claudeCode: null, transcript: null, history: [], hold: null });
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
  assert.equal(existsSync(join(dir, 'model-floor.lock')), false);
});

test('resetFloor repairs a corrupt registry and works on a fresh machine', async (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, '{garbage');
  assert.equal(readFloor({ dir }).ok, false);
  await resetFloor({ dir });
  assert.equal(readFloor({ dir }).ok, true);
  const fresh = join(tmp(t), 'g');
  await resetFloor({ dir: fresh });
  assert.equal(readFloor({ dir: fresh }).floor, MIN_FABLE);
});

test('reset --hold sets the cap, the cap holds against raises and plain resets, --clear-hold lifts it', async (t) => {
  const dir = join(tmp(t), 'f');
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const held = await resetFloor({ dir, hold: 'claude-fable-5-3-20261110' });
  assert.equal(held.registry.hold, 'claude-fable-5-3');
  assert.equal(held.floor, MIN_FABLE);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-4' }).reason, 'above-hold');
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-3', now: NOW }).raised, true);
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-3');
  const again = await resetFloor({ dir });
  assert.equal(again.registry.hold, 'claude-fable-5-3', 'a plain reset keeps an existing hold');
  assert.equal(again.floor, MIN_FABLE);
  const cleared = await resetFloor({ dir, clearHold: true });
  assert.equal(cleared.registry.hold, null);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-4', now: NOW }).raised, true);
  // a hold below the constant is a ceiling too (alias rollback)
  const rollback = await resetFloor({ dir, hold: 'claude-fable-5-1' });
  assert.equal(rollback.floor, 'claude-fable-5-1');
});

test('resetFloor rejects a bad hold, both flags together, and writes nothing', async (t) => {
  const dir = join(tmp(t), 'f');
  writeReg(dir, good());
  const before = readFileSync(reg(dir), 'utf8');
  await assert.rejects(resetFloor({ dir, hold: 'claude-opus-4-6' }), { code: 'model-floor-bad-hold' });
  await assert.rejects(resetFloor({ dir, hold: 'nope' }), { code: 'model-floor-bad-hold' });
  await assert.rejects(resetFloor({ dir, hold: 'claude-fable-5-3', clearHold: true }), { code: 'model-floor-bad-hold' });
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

test('resetFloor --clear-lock removes a lock a live holder left; without it reset reports busy', async (t) => {
  const dir = join(tmp(t), 'f');
  mkdirSync(dir, { recursive: true });
  assert.equal(tryAcquire('model-floor', { dir, machineId: null }).acquired, true); // this very process: alive, so never reclaimed
  await assert.rejects(resetFloor({ dir, waitMs: 100 }), { code: 'model-floor-busy' });
  const r = await resetFloor({ dir, clearLock: true });
  assert.equal(r.clearedLock, true);
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
  assert.equal(existsSync(join(dir, 'model-floor.lock')), false);
  assert.equal((await resetFloor({ dir, clearLock: true })).clearedLock, false, 'nothing to clear');
});

test('a dead holder\'s stale lock is reclaimed by the next lock taker', async (t) => {
  const dir = join(tmp(t), 'f');
  mkdirSync(dir, { recursive: true });
  const lockDir = join(dir, 'model-floor.lock');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ name: 'model-floor', runId: 'x-1', pid: 2147483646, host: (await import('node:os')).hostname(), startedAt: new Date().toISOString() }));
  assert.equal(await withFloorLock({ dir, waitMs: 2000, pollMs: 10 }, () => 'ran'), 'ran');
});

// ---- the checkout-only folder override ----
test('a repo checkout honours PIPELINE_MODEL_FLOOR_DIR, with or without PIPELINE_TEST_MODE', (t) => {
  const root = tmp(t); // no INSTALLED.json: a checkout
  const dir = join(tmp(t), 'scratch-floor');
  const warnings = [];
  for (const env of [{ PIPELINE_MODEL_FLOOR_DIR: dir }, { PIPELINE_MODEL_FLOOR_DIR: dir, PIPELINE_TEST_MODE: '1' }]) {
    assert.equal(floorDir({ env, root, warn: (m) => warnings.push(m) }), dir);
  }
  assert.equal(raiseFloor({ env: { PIPELINE_MODEL_FLOOR_DIR: dir }, root, model: 'claude-fable-5-3', now: NOW }).raised, true);
  assert.equal(existsSync(reg(dir)), true);
  assert.equal(readFloor({ env: { PIPELINE_MODEL_FLOOR_DIR: dir }, root }).floor, 'claude-fable-5-3');
  assert.deepEqual(warnings, []);
});

test('an installed copy ignores PIPELINE_MODEL_FLOOR_DIR and warns on stderr', (t) => {
  const root = tmp(t);
  writeFileSync(join(root, 'INSTALLED.json'), '{}');
  const home = tmp(t);
  const dir = join(tmp(t), 'scratch-floor');
  const warnings = [];
  const opts = { env: { PIPELINE_MODEL_FLOOR_DIR: dir, PIPELINE_TEST_MODE: '1' }, root, home, warn: (m) => warnings.push(m) };
  assert.equal(floorDir(opts), join(home, FLOOR_REL), 'the account folder, not the override');
  assert.equal(raiseFloor({ ...opts, model: 'claude-fable-5-3', now: NOW }).raised, true);
  assert.equal(existsSync(dir), false, 'nothing written to the override');
  assert.equal(existsSync(join(home, FLOOR_REL, 'fable.json')), true);
  assert.equal(warnings.length, 1, warnings.join(''));
  assert.match(warnings[0], /PIPELINE_MODEL_FLOOR_DIR/);
  assert.match(warnings[0], /installed copy/);
});

test('an injected dir wins over everything, and an empty override is ignored', (t) => {
  const root = tmp(t);
  const dir = join(tmp(t), 'inj');
  const other = join(tmp(t), 'env');
  assert.equal(floorDir({ dir, env: { PIPELINE_MODEL_FLOOR_DIR: other }, root }), dir);
  const home = tmp(t);
  assert.equal(floorDir({ env: { PIPELINE_MODEL_FLOOR_DIR: '' }, root, home }), join(home, FLOOR_REL));
});

// ---- the re-review threshold and the owner's exact-id allowance (review round 1: R1-B1, R1-F1) ----
test('reReviewThreshold: the hold when it is below MIN_FABLE, else MIN_FABLE; readReviewGate falls back to MIN_FABLE when the registry is unreadable', (t) => {
  const dir = join(tmp(t), 'f');
  assert.equal(reReviewThreshold(null), MIN_FABLE);
  assert.equal(reReviewThreshold(good({ hold: null })), MIN_FABLE);
  assert.equal(reReviewThreshold(good({ hold: 'claude-fable-5-1' })), 'claude-fable-5-1');
  assert.equal(reReviewThreshold(good({ hold: 'claude-fable-5-2' })), MIN_FABLE);
  assert.equal(reReviewThreshold(good({ hold: 'claude-fable-5-4' })), MIN_FABLE, 'a hold above the constant does not raise the re-review threshold');
  assert.deepEqual(readReviewGate({ dir }), { threshold: MIN_FABLE, allow: [] }, 'no registry file');
  writeReg(dir, good({ hold: 'claude-fable-5-1-20261001', allow: ['claude-fable-9-preview'] }));
  assert.deepEqual(readReviewGate({ dir }), { threshold: 'claude-fable-5-1', allow: ['claude-fable-9-preview'] });
  writeReg(dir, '{not json');
  assert.deepEqual(readReviewGate({ dir }), { threshold: MIN_FABLE, allow: [] }, 'unreadable: the stricter threshold, nothing allowed');
});

test('checkFloor: an allowed exact id is neither unparseable nor older; any other id is still judged', () => {
  const models = ['claude-fable-9-preview', 'claude-fable-5-1', 'claude-fable-x'];
  assert.deepEqual(checkFloor({ models, floor: MIN_FABLE }), { ok: false, older: ['claude-fable-5-1'], unparseable: ['claude-fable-9-preview', 'claude-fable-x'] });
  assert.deepEqual(checkFloor({ models, floor: MIN_FABLE, allow: ['claude-fable-9-preview'] }), { ok: false, older: ['claude-fable-5-1'], unparseable: ['claude-fable-x'] });
  assert.equal(checkFloor({ models, floor: MIN_FABLE, allow: models }).ok, true);
  assert.equal(checkFloor({ models: ['claude-fable-5-2-extra'], floor: MIN_FABLE, allow: ['claude-fable-5-2'] }).ok, false, 'exact match only');
});

test('resetFloor --allow-id: stores the ids (deduplicated, kept by a later reset and by raiseFloor), --clear-allow removes them, at most ALLOW_MAX', async (t) => {
  const dir = join(tmp(t), 'f');
  const r = await resetFloor({ dir, allowId: ['claude-fable-9-preview', 'claude-fable-9-preview', 'claude-fable-x'] });
  assert.deepEqual(r.registry.allow, ['claude-fable-9-preview', 'claude-fable-x']);
  assert.deepEqual(JSON.parse(readFileSync(reg(dir), 'utf8')).allow, ['claude-fable-9-preview', 'claude-fable-x']);
  assert.deepEqual(readFloor({ dir }).registry.allow, ['claude-fable-9-preview', 'claude-fable-x'], 'the registry still passes the schema check');
  assert.equal(readFloor({ dir }).floor, MIN_FABLE, 'an allowance never raises the floor');
  raiseFloor({ dir, model: 'claude-fable-5-4', now: NOW });
  assert.deepEqual(readFloor({ dir }).registry.allow, ['claude-fable-9-preview', 'claude-fable-x'], 'raising the floor keeps the allowance');
  assert.deepEqual((await resetFloor({ dir, allowId: ['claude-fable-y'] })).registry.allow, ['claude-fable-9-preview', 'claude-fable-x', 'claude-fable-y']);
  assert.deepEqual((await resetFloor({ dir })).registry.allow, ['claude-fable-9-preview', 'claude-fable-x', 'claude-fable-y'], 'a plain reset keeps it, like a hold');
  const cleared = await resetFloor({ dir, clearAllow: true });
  assert.equal(Object.hasOwn(cleared.registry, 'allow'), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(reg(dir), 'utf8')), 'allow'), false);

  const many = Array.from({ length: ALLOW_MAX + 1 }, (_, i) => `claude-fable-${i + 10}`);
  await assert.rejects(resetFloor({ dir, allowId: many }), { code: 'model-floor-bad-allow' });
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(reg(dir), 'utf8')), 'allow'), false, 'a refused reset writes nothing');
  assert.equal((await resetFloor({ dir, allowId: many.slice(0, ALLOW_MAX) })).registry.allow.length, ALLOW_MAX);
});

test('resetFloor refuses an allowed id that is not a claude-fable-* name, and --allow-id with --clear-allow', async (t) => {
  const dir = join(tmp(t), 'f');
  for (const bad of ['claude-opus-5-5', 'fable', 'claude-fable-', 'claude-fable-5 2', 'claude-fable-5\n', '../claude-fable-5', 5, null]) {
    await assert.rejects(resetFloor({ dir, allowId: [bad] }), { code: 'model-floor-bad-allow' }, String(bad));
  }
  await assert.rejects(resetFloor({ dir, allowId: ['claude-fable-9'], clearAllow: true }), { code: 'model-floor-bad-allow' });
  assert.equal(existsSync(reg(dir)), false, 'nothing was written');
});

test('a registry with a malformed allow list is unreadable (fail closed)', (t) => {
  const dir = join(tmp(t), 'f');
  const many = Array.from({ length: ALLOW_MAX + 1 }, (_, i) => `claude-fable-${i + 10}`);
  for (const allow of ['claude-fable-9', [5], ['claude-opus-5-5'], ['claude-fable-a b'], many, {}]) {
    writeReg(dir, good({ allow }));
    assert.equal(readFloor({ dir }).ok, false, JSON.stringify(allow));
  }
  writeReg(dir, good({ allow: [] }));
  assert.equal(readFloor({ dir }).ok, true);
});
