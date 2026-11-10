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
  assert.match(meta.usage, /--allow-id <exact claude-fable-… id> \.\.\. \| --remove-allow <id> \.\.\. \| --clear-allow/);
  assert.match(meta.usage, /model-floor reset --allow-id <the new id>/, 'the documented recovery for an unreadable id is the allowance, not a hold');
  assert.match(meta.usage, /--clear-allow/);
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

test('reset --clear-lock removes a lock another machine left', async (t) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  assert.equal(tryAcquire('model-floor', { dir, host: 'another-host.invalid', machineId: 'another-machine-id' }).acquired, true); // alive pid, but not on this machine: never reclaimed
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
  assert.deepEqual(fresh.output, { ok: true, floor: MIN_FABLE, MIN_FABLE, registry: null, readableAllowed: [], file: reg(dir) });
  assert.equal(existsSync(dir), false, 'show creates nothing');
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const raised = await run(['show'], { env: { ...ownerEnv(dir), CLAUDECODE: '1' }, hasClaudeCodeAncestor: () => true });
  assert.equal(raised.output.floor, 'claude-fable-5-5');
  assert.equal(raised.output.registry.newest, 'claude-fable-5-5');
});

test('R3-F2: show lists readableAllowed, the allowed ids the parser can read now (and is read-only about it); an unreadable id is not listed', async (t) => {
  const dir = scratch(t);
  await run(['reset', '--allow-id', 'claude-fable-6-preview', '--allow-id', 'claude-fable-5-3', '--allow-id', 'claude-fable-6'], asOwner(dir));
  const before = readFileSync(reg(dir), 'utf8');
  const shown = await run(['show'], { env: { ...ownerEnv(dir), CLAUDECODE: '1' } });
  assert.deepEqual(shown.output.readableAllowed, ['claude-fable-5-3', 'claude-fable-6']);
  assert.deepEqual(shown.output.registry.allow, ['claude-fable-6-preview', 'claude-fable-5-3', 'claude-fable-6'], 'the registry itself is untouched');
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
  assert.match(meta.usage, /readableAllowed/);
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

// ---- reset --allow-id / --clear-allow (review round 1: R1-F1) ----
test('reset --allow-id stores exact ids (repeatable) and shows them in the output; --clear-allow removes them; a plain reset keeps them', async (t) => {
  const dir = scratch(t);
  const r = await run(['reset', '--allow-id', 'claude-fable-6-preview', '--allow-id', 'claude-fable-6-b'], asOwner(dir));
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.output, { ok: true, floor: MIN_FABLE, hold: null, allow: ['claude-fable-6-preview', 'claude-fable-6-b'], file: reg(dir), clearedLock: false });
  assert.deepEqual(readReg(dir).allow, ['claude-fable-6-preview', 'claude-fable-6-b']);
  assert.equal(readFloor({ dir }).floor, MIN_FABLE, 'it never raises the floor');
  assert.deepEqual((await run(['show'], asOwner(dir))).output.registry.allow, ['claude-fable-6-preview', 'claude-fable-6-b']);
  assert.deepEqual((await run(['reset'], asOwner(dir))).output.allow, ['claude-fable-6-preview', 'claude-fable-6-b']);
  const cleared = await run(['reset', '--clear-allow'], asOwner(dir));
  assert.equal(cleared.exitCode, 0);
  assert.equal(Object.hasOwn(cleared.output, 'allow'), false);
  assert.equal(Object.hasOwn(readReg(dir), 'allow'), false);
});

test('reset --allow-id is refused inside Claude Code (env and ancestor), registry untouched', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  const inEnv = await run(['reset', '--allow-id', 'claude-fable-6-preview'], { env: { ...ownerEnv(dir), CLAUDECODE: '1' }, hasClaudeCodeAncestor: () => false });
  assert.equal(inEnv.exitCode, 2);
  assert.equal(inEnv.output.error, 'refused');
  for (const args of [['reset', '--allow-id', 'claude-fable-6-preview'], ['reset', '--clear-allow']]) {
    const r = await run(args, { env: ownerEnv(dir), hasClaudeCodeAncestor: () => true });
    assert.equal(r.exitCode, 2, args.join(' '));
    assert.equal(r.output.error, 'refused');
  }
  const bin2 = spawnSync(process.execPath, [bin, 'model-floor', 'reset', '--allow-id', 'claude-fable-6-preview'], { encoding: 'utf8', env: { ...ownerEnv(dir), CLAUDECODE: '1' } });
  assert.equal(bin2.status, 2, bin2.stderr);
  assert.equal(JSON.parse(bin2.stdout).error, 'refused');
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

test('reset --allow-id usage errors: a non-claude-fable id, an empty one, both flags, more than ten; nothing is written', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-5', now: NOW });
  const before = readFileSync(reg(dir), 'utf8');
  const eleven = ['reset', ...Array.from({ length: 11 }, (_, i) => ['--allow-id', `claude-fable-${i + 10}`]).flat()];
  const cases = [
    ['reset', '--allow-id', 'claude-opus-4-6'], ['reset', '--allow-id', 'fable'], ['reset', '--allow-id', ''], ['reset', '--allow-id'],
    ['reset', '--allow-id', 'claude-fable-6', '--clear-allow'], ['show', '--allow-id', 'claude-fable-6'], ['show', '--clear-allow'],
  ];
  for (const args of cases) await assert.rejects(run(args, asOwner(dir)), UsageError, JSON.stringify(args));
  const tooMany = await run(eleven, asOwner(dir));
  assert.equal(tooMany.exitCode, 2);
  assert.equal(tooMany.output.error, 'model-floor-bad-allow');
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
});

// ---- review round 2: R2-F1 (an allowance-only call keeps the learned floor) ----
test('R2-F1: reset --allow-id and --clear-allow alone keep a floor proofs raised; a plain reset drops it to MIN_FABLE; a corrupt registry refuses the allowance-only call', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-3', claudeCode: '2.1.400', transcript: '/t.jsonl', now: NOW });
  const learned = readReg(dir);
  const allowed = await run(['reset', '--allow-id', 'claude-fable-6-preview'], asOwner(dir));
  assert.deepEqual([allowed.exitCode, allowed.output.floor, allowed.output.allow], [0, 'claude-fable-5-3', ['claude-fable-6-preview']]);
  assert.deepEqual(readReg(dir), { ...learned, allow: ['claude-fable-6-preview'] }, 'only allow changed');
  const cleared = await run(['reset', '--clear-allow'], asOwner(dir));
  assert.deepEqual([cleared.exitCode, cleared.output.floor], [0, 'claude-fable-5-3']);
  assert.deepEqual(readReg(dir), learned);
  await run(['reset', '--allow-id', 'claude-fable-6-preview'], asOwner(dir));
  const plain = await run(['reset'], asOwner(dir));
  assert.equal(plain.output.floor, MIN_FABLE, 'a plain reset still rewrites to the shipped minimum');
  assert.equal(readReg(dir).newest, MIN_FABLE);

  writeFileSync(reg(dir), '{ not json');
  for (const args of [['reset', '--allow-id', 'claude-fable-6-preview'], ['reset', '--clear-allow']]) {
    const refused = await run(args, asOwner(dir));
    assert.equal(refused.exitCode, 1, args.join(' '));
    assert.equal(refused.output.error, 'model-floor-unreadable');
    assert.match(refused.output.message, /plain .*model-floor reset.* first/);
    assert.equal(readFileSync(reg(dir), 'utf8'), '{ not json', 'nothing written');
  }
  assert.equal((await run(['reset'], asOwner(dir))).exitCode, 0, 'the plain reset repairs it');
});

test('R2-F1: the usage text says an allowance-only call keeps the learned floor and a corrupt registry needs a plain reset first', () => {
  assert.match(meta.usage, /with --allow-id, --remove-allow and\/or --clear-allow \(and no --hold \/ --clear-hold; --clear-lock alongside is fine\) it is not a reset/);
  assert.match(meta.usage, /plain `model-floor reset` first/);
  assert.match(meta.usage, /A plain reset .* rewrites the registry to the shipped minimum/);
  assert.match(meta.usage, /a bare --clear-lock too/);
  assert.match(meta.usage, /add --keep-floor to clear the lock and keep the learned floor/);
  assert.match(meta.usage, /pipeline model-floor reset --clear-lock --keep-floor/);
  assert.match(meta.usage, /--remove-allow <id>  remove exactly that id/);
});

test('R3-F1: --allow-id / --clear-allow with --clear-lock keep the learned floor and clear the lock; a bare --clear-lock is a plain reset', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-3', claudeCode: '2.1.400', transcript: '/t.jsonl', now: NOW });
  const learned = readReg(dir);
  const lock = () => mkdirSync(join(dir, 'model-floor.lock'), { recursive: true });
  lock();
  const allowed = await run(['reset', '--allow-id', 'claude-fable-6-preview', '--clear-lock'], asOwner(dir));
  assert.deepEqual([allowed.exitCode, allowed.output.floor, allowed.output.clearedLock], [0, 'claude-fable-5-3', true]);
  assert.deepEqual(readReg(dir), { ...learned, allow: ['claude-fable-6-preview'] });
  lock();
  const cleared = await run(['reset', '--clear-allow', '--clear-lock'], asOwner(dir));
  assert.deepEqual([cleared.exitCode, cleared.output.floor, cleared.output.clearedLock], [0, 'claude-fable-5-3', true]);
  assert.deepEqual(readReg(dir), learned);
  const bare = await run(['reset', '--clear-lock'], asOwner(dir));
  assert.equal(bare.output.floor, MIN_FABLE, 'a bare --clear-lock is a plain reset');
});

// ---- review round 4: R4-F2 (--remove-allow, --keep-floor) ----
test('R4-F2: reset --remove-allow removes exactly the named ids and keeps the learned floor and the other ids; an unknown id is refused naming the list', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-3', claudeCode: '2.1.400', transcript: '/t.jsonl', now: NOW });
  const learned = readReg(dir);
  await run(['reset', '--allow-id', 'claude-fable-6-preview', '--allow-id', 'claude-fable-5-3'], asOwner(dir));
  const r = await run(['reset', '--remove-allow', 'claude-fable-5-3'], asOwner(dir));
  assert.deepEqual([r.exitCode, r.output.floor, r.output.allow], [0, 'claude-fable-5-3', ['claude-fable-6-preview']]);
  assert.deepEqual(readReg(dir), { ...learned, allow: ['claude-fable-6-preview'] }, 'only allow changed');
  // repeatable, and combines with --allow-id and --clear-lock
  mkdirSync(join(dir, 'model-floor.lock'), { recursive: true });
  const both = await run(['reset', '--remove-allow', 'claude-fable-6-preview', '--allow-id', 'claude-fable-6-b', '--clear-lock'], asOwner(dir));
  assert.deepEqual([both.exitCode, both.output.allow, both.output.clearedLock, both.output.floor], [0, ['claude-fable-6-b'], true, 'claude-fable-5-3']);

  const before = readFileSync(reg(dir), 'utf8');
  const unknown = await run(['reset', '--remove-allow', 'claude-fable-6-zzz'], asOwner(dir));
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.output.error, 'model-floor-bad-allow');
  assert.match(unknown.output.message, /claude-fable-6-zzz/);
  assert.match(unknown.output.message, /claude-fable-6-b/, 'names the current list');
  assert.equal(readFileSync(reg(dir), 'utf8'), before, 'nothing written');
  await assert.rejects(run(['reset', '--remove-allow', 'claude-fable-6-b', '--clear-allow'], asOwner(dir)), UsageError);
  const notFable = await run(['reset', '--remove-allow', 'not-a-fable'], asOwner(dir));
  assert.deepEqual([notFable.exitCode, notFable.output.error], [2, 'model-floor-bad-allow']);
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
  await assert.rejects(run(['show', '--remove-allow', 'claude-fable-6-b'], asOwner(dir)), UsageError);
  const emptied = await run(['reset', '--remove-allow', 'claude-fable-6-b'], asOwner(dir));
  assert.deepEqual([emptied.exitCode, emptied.output.allow], [0, undefined]);
  assert.deepEqual(readReg(dir), learned, 'back to exactly the learned registry');
});

test('R4-F2: reset --remove-allow and --keep-floor are refused inside Claude Code and change nothing', async (t) => {
  const dir = scratch(t);
  raiseFloor({ dir, model: 'claude-fable-5-3', now: NOW });
  await run(['reset', '--allow-id', 'claude-fable-6-preview'], asOwner(dir));
  const before = readFileSync(reg(dir), 'utf8');
  mkdirSync(join(dir, 'model-floor.lock'), { recursive: true });
  for (const args of [['reset', '--remove-allow', 'claude-fable-6-preview'], ['reset', '--clear-lock', '--keep-floor']]) {
    for (const env of [{ ...ownerEnv(dir), CLAUDECODE: '1' }, ownerEnv(dir)]) {
      const r = await run(args, { env, hasClaudeCodeAncestor: () => env.CLAUDECODE === undefined });
      assert.equal(r.exitCode, 2, args.join(' '));
      assert.equal(r.output.error, 'refused');
    }
  }
  assert.equal(readFileSync(reg(dir), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'model-floor.lock')), true, 'the lock is still there');
});

test('R4-F2: reset --clear-lock --keep-floor removes the lock and keeps the learned floor, hold and allowances; --keep-floor alone or with other options is a usage error', async (t) => {
  const dir = scratch(t);
  await run(['reset', '--hold', 'claude-fable-5-4'], asOwner(dir));
  raiseFloor({ dir, model: 'claude-fable-5-3', claudeCode: '2.1.400', transcript: '/t.jsonl', now: NOW });
  await run(['reset', '--allow-id', 'claude-fable-6-preview'], asOwner(dir));
  const bytes = readFileSync(reg(dir), 'utf8');
  mkdirSync(join(dir, 'model-floor.lock'), { recursive: true });
  const r = await run(['reset', '--clear-lock', '--keep-floor'], asOwner(dir));
  assert.deepEqual([r.exitCode, r.output.floor, r.output.hold, r.output.allow, r.output.clearedLock], [0, 'claude-fable-5-3', 'claude-fable-5-4', ['claude-fable-6-preview'], true]);
  assert.equal(readFileSync(reg(dir), 'utf8'), bytes, 'registry byte-identical');
  assert.equal(existsSync(join(dir, 'model-floor.lock')), false);
  for (const args of [['reset', '--keep-floor'], ['reset', '--keep-floor', '--clear-lock', '--clear-allow'], ['reset', '--keep-floor', '--clear-lock', '--allow-id', 'claude-fable-6-b'],
    ['reset', '--keep-floor', '--clear-lock', '--remove-allow', 'claude-fable-6-preview'], ['reset', '--keep-floor', '--clear-lock', '--hold', 'claude-fable-5-4'], ['show', '--keep-floor']]) {
    await assert.rejects(run(args, asOwner(dir)), UsageError, args.join(' '));
  }
  assert.equal(readFileSync(reg(dir), 'utf8'), bytes);
  const bare = await run(['reset', '--clear-lock'], asOwner(dir));
  assert.equal(bare.output.floor, MIN_FABLE, 'a bare --clear-lock is still the plain reset');
});

test('R1-B2: reset --clear-lock (plain and --keep-floor) exits 1 model-floor-lock-live, naming the pid, while a running local process holds the lock; a dead holder clears', async (t) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  raiseFloor({ dir, model: 'claude-fable-5-3', now: NOW });
  const bytes = readFileSync(reg(dir), 'utf8');
  assert.equal(tryAcquire('model-floor', { dir, machineId: null }).acquired, true); // this very process: running
  for (const args of [['reset', '--clear-lock'], ['reset', '--clear-lock', '--keep-floor'], ['reset', '--clear-lock', '--allow-id', 'claude-fable-6-preview']]) {
    const r = await run(args, asOwner(dir));
    assert.equal(r.exitCode, 1, args.join(' '));
    assert.equal(r.output.error, 'model-floor-lock-live');
    assert.match(r.output.message, new RegExp(`pid ${process.pid}\\b`));
    assert.match(r.output.message, /ps -p \d+ -o command=/);
    assert.ok(r.output.message.includes(join(dir, 'model-floor.lock')), 'names the lock folder');
    assert.equal(existsSync(join(dir, 'model-floor.lock')), true);
    assert.equal(readFileSync(reg(dir), 'utf8'), bytes);
  }
  rmSync(join(dir, 'model-floor.lock'), { recursive: true });
  assert.equal(tryAcquire('model-floor', { dir, pid: 2147483646, machineId: null }).acquired, true);
  const r = await run(['reset', '--clear-lock', '--keep-floor'], asOwner(dir));
  assert.deepEqual([r.exitCode, r.output.clearedLock], [0, true]);
  assert.equal(readFileSync(reg(dir), 'utf8'), bytes);
});

test('R1-B2: the usage says --clear-lock refuses while the holder is running', () => {
  assert.match(meta.usage, /--clear-lock .*refuses while the holder is a running process on this machine \(exit 1 model-floor-lock-live, naming the pid and the lock folder\)/);
  assert.match(meta.usage, /confirm that pid is a pipeline process \(`ps -p <pid> -o command=`\).*remove the lock folder by hand/, 'R7-F2: how to tell a recycled pid');
  assert.match(meta.usage, /removes only the lock it inspected .*model-floor-lock-changed.*model-floor-lock-unreadable/, 'R7-B1/F1');
});
