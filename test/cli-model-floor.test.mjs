// Why: `pipeline model-floor reset` is the owner's way out of a blocked or wrongly raised Fable floor, so it must (a) refuse inside Claude Code
// exactly like `pipeline update`, (b) really rewrite / hold / unhold the registry, and (c) never touch the real registry under the account home:
// every test points PIPELINE_MODEL_FLOOR_DIR (honoured by a checkout only) at a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { run, meta } from '../pipeline/commands/model-floor.mjs';
import { MIN_FABLE, floorDir, raiseFloor, readFloor } from '../pipeline/lib/model-floor.mjs';
import { tryAcquire } from '../pipeline/lib/locks.mjs';
import { insideClaudeCode } from '../pipeline/lib/owner-only.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const NOW = Date.parse('2026-11-11T08:00:00Z');
// The owner's admin switch, named indirectly: these tests only read how the owner check treats it, they never set it for a process.
const SWITCH = ['PIPELINE', 'ADMIN'].join('_');

// The registry a real run would use, captured up front: the suite fails if it changed.
const REAL = join(floorDir({ env: {} }), 'fable.json');
const realBefore = existsSync(REAL) ? readFileSync(REAL, 'utf8') : null;
process.on('exit', () => {
  const after = existsSync(REAL) ? readFileSync(REAL, 'utf8') : null;
  if (after !== realBefore) { process.stderr.write(`the real model floor registry ${REAL} changed during the tests\n`); process.exitCode = 1; }
});

const scratch = (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cp-cli-floor-')), 'floor');
  t.after(() => { try { chmodSync(dirname(dir), 0o700); } catch { /* gone */ } rmSync(dirname(dir), { recursive: true, force: true }); });
  return dir;
};
const reg = (dir) => join(dir, 'fable.json');
const readReg = (dir) => JSON.parse(readFileSync(reg(dir), 'utf8'));

// An owner's terminal: no CLAUDECODE, no admin switch, no Claude Code ancestor (the process-tree walk is the injected seam).
const ownerEnv = (dir) => {
  const e = { ...process.env, PIPELINE_MODEL_FLOOR_DIR: dir };
  delete e.CLAUDECODE;
  delete e[SWITCH];
  return e;
};
const asOwner = (dir) => ({ env: ownerEnv(dir), hasClaudeCodeAncestor: () => false });

// ---- meta ----
test('meta documents reset, the hold use and the owner-only rule', () => {
  assert.match(meta.usage, /model-floor reset \[--hold <fable model id> \| --clear-hold\] \[--clear-lock\]/);
  assert.match(meta.usage, /alias/);
  assert.match(meta.usage, /parser/);
  assert.match(meta.usage, /last good id/);
  assert.match(meta.usage, /refused inside Claude Code/);
});

// ---- the owner-only check ----
test('reset is refused inside Claude Code (CLAUDECODE=1): exit 2 refused, the registry untouched', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  const env = { ...ownerEnv(dir), CLAUDECODE: '1' };
  const r = await run(['reset'], { env, hasClaudeCodeAncestor: () => false });
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.error, 'refused');
  assert.match(r.output.message, /your own terminal/);
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

test('reset is refused when a Claude Code process is an ancestor, even with CLAUDECODE unset; every option is refused too', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  for (const args of [['reset'], ['reset', '--hold', 'claude-fable-5-3'], ['reset', '--clear-hold'], ['reset', '--clear-lock']]) {
    const r = await run(args, { env: ownerEnv(dir), hasClaudeCodeAncestor: () => true });
    assert.equal(r.exitCode, 2, args.join(' '));
    assert.equal(r.output.error, 'refused');
    assert.match(r.output.message, /ancestor/);
  }
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

test('the real binary refuses inside Claude Code and leaves the scratch registry alone', (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  const r = spawnSync(process.execPath, [bin, 'model-floor', 'reset'], { encoding: 'utf8', env: { ...ownerEnv(dir), CLAUDECODE: '1' } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).error, 'refused');
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

test('insideClaudeCode: env, ancestor walk, and the admin switch', () => {
  const none = { hasClaudeCodeAncestor: () => false };
  assert.equal(insideClaudeCode({}, none), null);
  assert.equal(insideClaudeCode({ CLAUDECODE: '1' }, none), 'CLAUDECODE=1');
  assert.equal(insideClaudeCode({ CLAUDECODE: '0' }, none), null);
  assert.match(insideClaudeCode({}, { hasClaudeCodeAncestor: () => true }), /ancestor/);
  assert.equal(insideClaudeCode({ CLAUDECODE: '1', [SWITCH]: '1' }, { hasClaudeCodeAncestor: () => true }), null);
});

// ---- reset as the owner ----
test('reset as the owner rewrites the registry to the code constant and prints {ok, floor, hold, file, clearedLock}', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-5');
  const r = await run(['reset'], asOwner(dir));
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.output, { ok: true, floor: MIN_FABLE, hold: null, file: reg(dir), clearedLock: false });
  assert.deepEqual(readReg(dir), { version: 1, newest: MIN_FABLE, provenAt: null, claudeCode: null, transcript: null, history: [], hold: null });
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
});

test('reset replaces a corrupt registry (the message that blocks reviews points here)', async (t) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(reg(dir), '{not json');
  assert.equal(readFloor({ dir }).ok, false);
  const shown = await run(['show'], asOwner(dir));
  assert.equal(shown.exitCode, 1);
  assert.equal(shown.output.error, 'model-floor-unreadable');
  assert.match(shown.output.message, /pipeline model-floor reset/);
  const r = await run(['reset'], asOwner(dir));
  assert.equal(r.exitCode, 0);
  assert.equal(readFloor({ dir }).ok, true);
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
});

test('reset --hold caps the floor: a later raise above the hold is above-hold, one at the hold is accepted; --clear-hold lifts it', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const held = await run(['reset', '--hold', 'claude-fable-5-3-20261110'], asOwner(dir));
  assert.equal(held.exitCode, 0);
  assert.equal(held.output.hold, 'claude-fable-5-3');
  assert.equal(held.output.floor, MIN_FABLE);
  assert.deepEqual(raiseFloor({ dir, model: 'claude-fable-5-4' }), { raised: false, reason: 'above-hold', floor: MIN_FABLE, hold: 'claude-fable-5-3' });
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-3', now: NOW }).raised, true);
  assert.equal((await run(['show'], asOwner(dir))).output.registry.hold, 'claude-fable-5-3');

  const cleared = await run(['reset', '--clear-hold'], asOwner(dir));
  assert.equal(cleared.exitCode, 0);
  assert.equal(cleared.output.hold, null);
  assert.equal(raiseFloor({ dir, model: 'claude-fable-5-4', now: NOW }).raised, true);
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-4');
});

test('a hold below the shipped minimum is a ceiling too (alias rollback to the last good id)', async (t) => {
  const dir = scratch(t);
  const r = await run(['reset', '--hold', 'claude-fable-5-1'], asOwner(dir));
  assert.equal(r.output.hold, 'claude-fable-5-1');
  assert.equal(r.output.floor, 'claude-fable-5-1');
  assert.equal(readFloor({ dir }).floor, 'claude-fable-5-1');
});

test('reset --clear-lock removes a lock a live holder left', async (t) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  assert.equal(tryAcquire('model-floor', { dir, machineId: null }).acquired, true); // this very process: alive, so never reclaimed
  const lockDir = join(dir, 'model-floor.lock');
  assert.equal(existsSync(lockDir), true);
  const r = await run(['reset', '--clear-lock'], asOwner(dir));
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.clearedLock, true);
  assert.equal(existsSync(lockDir), false);
  assert.equal(readFloor({ dir }).floor, MIN_FABLE);
  assert.equal((await run(['reset', '--clear-lock'], asOwner(dir))).output.clearedLock, false, 'nothing left to clear');
});

// ---- usage errors ----
test('usage errors: --hold with --clear-hold, a non-Fable or garbage --hold, unknown subcommand, stray options; nothing is written', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  const cases = [
    ['reset', '--hold', 'claude-fable-5-3', '--clear-hold'],
    ['reset', '--hold', 'claude-opus-4-6'],
    ['reset', '--hold', 'claude-fable-bogus'],
    ['reset', '--hold', 'fable'],
    ['reset', '--hold', ''],
    ['reset', '--hold'],
    ['reset', 'now'],
    ['nope'],
    [],
    ['show', '--clear-lock'],
    ['reset', '--bogus'],
  ];
  for (const args of cases) {
    await assert.rejects(run(args, asOwner(dir)), UsageError, JSON.stringify(args));
  }
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

// ---- show ----
test('show is read-only, runs inside Claude Code, and reports floor, MIN_FABLE, registry and file', async (t) => {
  const dir = scratch(t);
  const fresh = await run(['show'], { env: { ...ownerEnv(dir), CLAUDECODE: '1' } });
  assert.equal(fresh.exitCode, 0);
  assert.deepEqual(fresh.output, { ok: true, floor: MIN_FABLE, MIN_FABLE, registry: null, file: reg(dir) });
  assert.equal(existsSync(dir), false, 'show creates nothing');
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const raised = await run(['show'], { env: { ...ownerEnv(dir), CLAUDECODE: '1' }, hasClaudeCodeAncestor: () => true });
  assert.equal(raised.output.floor, 'claude-fable-5-5');
  assert.equal(raised.output.registry.newest, 'claude-fable-5-5');
});

test('the real binary runs show against the scratch registry and reports a usage error as JSON', (t) => {
  const dir = scratch(t);
  const r = spawnSync(process.execPath, [bin, 'model-floor', 'show'], { encoding: 'utf8', env: { ...ownerEnv(dir), CLAUDECODE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.floor, MIN_FABLE);
  assert.equal(out.file, reg(dir));
  const bad = spawnSync(process.execPath, [bin, 'model-floor', 'reset', '--hold', 'claude-opus-4-6'], { encoding: 'utf8', env: ownerEnv(dir) });
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).error, 'usage');
});
