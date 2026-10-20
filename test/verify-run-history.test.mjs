// Every verify run appends one JSON line to a machine-wide history file so the local Command Centre wallboard can count
// all runs per day (a worktree's .verify/report.json keeps only its last). The keys are read by another repo, so they are
// pinned here. The lib is vendored into projects (scripts/pipeline/lib) and used by the verify template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendHistory, buildHistoryLine, historyPath } from '../pipeline/lib/verify-run-history.mjs';
import { release, tryAcquire } from '../pipeline/lib/locks.mjs';
import { project, scratchDir, importVendored } from './helpers/project.mjs';

const template = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'templates', 'scripts', 'verify.mjs');
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const OPTS = { project: 'demo-app', dir: join('work', 'tree'), exitCode: 0 };
const report = (over = {}) => ({
  version: 1,
  mode: 'full',
  ok: true,
  startedAt: '2026-10-20T01:00:00.000Z',
  finishedAt: '2026-10-20T01:00:05.500Z',
  git: { head: 'a'.repeat(40) },
  steps: [
    { name: 'lint', status: 'pass', durationMs: 1200, command: 'npm run lint', exitCode: 0, errorExcerpt: '' },
    { name: 'db', status: 'skipped', durationMs: 3, skipKind: 'local', skipReason: 'nothing changed', skipCheck: 'cache hit', command: 'x', exitCode: null, errorExcerpt: '' },
  ],
  ...over,
});

// ---- buildHistoryLine

test('buildHistoryLine: exactly the agreed keys and values, skip fields only on the step that has them', () => {
  const o = JSON.parse(buildHistoryLine(report(), OPTS));
  assert.deepEqual(Object.keys(o), ['v', 'project', 'dir', 'head', 'mode', 'ok', 'exitCode', 'startedAt', 'finishedAt', 'durationMs', 'steps']);
  assert.equal(o.v, 1);
  assert.equal(o.project, 'demo-app');
  assert.equal(o.dir, OPTS.dir);
  assert.equal(o.head, 'a'.repeat(40));
  assert.equal(o.mode, 'full');
  assert.equal(o.ok, true);
  assert.equal(o.exitCode, 0);
  assert.equal(o.durationMs, 5500);
  assert.deepEqual(o.steps, [
    { name: 'lint', status: 'pass', durationMs: 1200 },
    { name: 'db', status: 'skipped', durationMs: 3, skipReason: 'nothing changed', skipCheck: 'cache hit' },
  ]);
  assert.equal('sqlArms' in o, false, 'no project-specific top-level key');
});

test('buildHistoryLine: head is null without git; error only when set; error cut to 300, skip fields to 200', () => {
  const o = JSON.parse(buildHistoryLine(report({ git: { head: null } }), OPTS));
  assert.equal(o.head, null);
  assert.equal('error' in o, false);
  const long = 'x'.repeat(1000);
  const e = JSON.parse(buildHistoryLine(report({ ok: false, error: long, steps: [{ name: 's', status: 'skipped', durationMs: 0, skipReason: long, skipCheck: long }] }), { ...OPTS, exitCode: 2 }));
  assert.equal(e.ok, false);
  assert.equal(e.exitCode, 2);
  assert.equal(e.error.length, 300);
  assert.equal(e.steps[0].skipReason.length, 200);
  assert.equal(e.steps[0].skipCheck.length, 200);
  assert.equal(JSON.parse(buildHistoryLine(report({ git: undefined }), OPTS)).head, null);
});

test('buildHistoryLine: stays under 4000 bytes: first the per-step skip fields go, then the steps', () => {
  const skipped = (i) => ({ name: `step-${i}`, status: 'skipped', durationMs: i, skipReason: 'r'.repeat(200), skipCheck: 'c'.repeat(200) });
  // 12 steps x ~480 bytes with skip fields (> 4000), ~60 bytes without: only the skip fields are dropped.
  const some = buildHistoryLine(report({ steps: Array.from({ length: 12 }, (_, i) => skipped(i)) }), OPTS);
  assert.ok(Buffer.byteLength(some) < 4000);
  const o = JSON.parse(some);
  assert.equal(o.steps.length, 12);
  assert.deepEqual(Object.keys(o.steps[0]), ['name', 'status', 'durationMs']);
  const many = buildHistoryLine(report({ steps: Array.from({ length: 400 }, (_, i) => skipped(i)) }), OPTS);
  assert.ok(Buffer.byteLength(many) < 4000);
  assert.deepEqual(JSON.parse(many).steps, []);
  assert.equal(JSON.parse(many).mode, 'full', 'the fallback only drops steps');
});

// ---- historyPath

test('historyPath: override, then VERIFY_RUN_HISTORY, then HOME, then USERPROFILE', () => {
  const tail = ['.claude', 'pipeline-state', 'verify-runs.jsonl'];
  assert.equal(historyPath({ HOME: 'h', VERIFY_RUN_HISTORY: 'v.jsonl' }, 'o.jsonl'), 'o.jsonl');
  assert.equal(historyPath({ HOME: 'h', VERIFY_RUN_HISTORY: 'v.jsonl' }), 'v.jsonl');
  assert.equal(historyPath({ HOME: 'h' }), join('h', ...tail));
  assert.equal(historyPath({ USERPROFILE: 'u' }), join('u', ...tail));
  assert.equal(historyPath({ HOME: 'h', USERPROFILE: 'u' }), join('h', ...tail));
});

test('historyPath: null when CI is set, VERIFY_RUN_HISTORY is off, or there is no home and no override', () => {
  assert.equal(historyPath({ HOME: 'h', CI: 'true' }, 'o.jsonl'), null);
  assert.equal(historyPath({ HOME: 'h', VERIFY_RUN_HISTORY: 'off' }, 'o.jsonl'), null);
  assert.equal(historyPath({}), null);
  assert.equal(historyPath(), null);
  assert.equal(historyPath({}, 'o.jsonl'), 'o.jsonl');
});

// ---- appendHistory

test('appendHistory: creates the folder and appends one line per call', () => {
  const file = join(scratchDir(), 'deep', 'verify-runs.jsonl');
  appendHistory(file, '{"a":1}');
  appendHistory(file, '{"a":2}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n');
});

test('appendHistory: a file over maxBytes moves to <file>.1 (replacing an old .1) and a fresh file starts', () => {
  const file = join(scratchDir(), 'h.jsonl');
  const lockDir = scratchDir();
  writeFileSync(`${file}.1`, 'old generation\n');
  appendHistory(file, 'x'.repeat(50), { maxBytes: 100, lockDir }); // 51 bytes: no rotation
  appendHistory(file, 'y'.repeat(60), { maxBytes: 100, lockDir }); // 51 bytes before this one: no rotation, 112 after
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'old generation\n');
  appendHistory(file, 'z', { maxBytes: 100, lockDir }); // 112 > 100: rotates first
  assert.equal(readFileSync(`${file}.1`, 'utf8'), `${'x'.repeat(50)}\n${'y'.repeat(60)}\n`);
  assert.equal(readFileSync(file, 'utf8'), 'z\n');
});

test('appendHistory: a writer that saw the big file before another writer rotated it does not rotate again (old generation survives)', () => {
  const file = join(scratchDir(), 'h.jsonl');
  const lockDir = scratchDir();
  const old = `${'o'.repeat(150)}\n`;
  writeFileSync(file, old);
  // Writer B has seen the big file; before it takes the lock, writer A rotates and appends to a fresh file.
  appendHistory(file, 'B-line', {
    maxBytes: 100,
    lockDir,
    hooks: { afterSizeCheck: () => appendHistory(file, 'A-line', { maxBytes: 100, lockDir }) },
  });
  assert.equal(readFileSync(`${file}.1`, 'utf8'), old, "not replaced by A's near-empty file");
  assert.equal(readFileSync(file, 'utf8'), 'A-line\nB-line\n');
});

test('appendHistory: does not rotate while another writer holds the rotation lock, but still appends', () => {
  const file = join(scratchDir(), 'h.jsonl');
  const lockDir = scratchDir();
  const big = `${'o'.repeat(150)}\n`;
  writeFileSync(file, big);
  const held = tryAcquire('verify-run-history', { dir: lockDir });
  assert.equal(held.acquired, true);
  try {
    appendHistory(file, 'next', { maxBytes: 100, lockDir });
  } finally {
    release(held.lock);
  }
  assert.equal(existsSync(`${file}.1`), false);
  assert.equal(readFileSync(file, 'utf8'), `${big}next\n`);
  appendHistory(file, 'after', { maxBytes: 100, lockDir }); // lock free again: this run rotates
  assert.equal(readFileSync(`${file}.1`, 'utf8'), `${big}next\n`);
  assert.equal(readFileSync(file, 'utf8'), 'after\n');
});

test('appendHistory: releases the rotation lock afterwards', () => {
  const file = join(scratchDir(), 'h.jsonl');
  const lockDir = scratchDir();
  writeFileSync(file, 'o'.repeat(150));
  appendHistory(file, 'x', { maxBytes: 100, lockDir });
  const again = tryAcquire('verify-run-history', { dir: lockDir });
  assert.equal(again.acquired, true);
  release(again.lock);
});

test('appendHistory: throws when the folder cannot be made (a parent is a file)', () => {
  const d = scratchDir();
  writeFileSync(join(d, 'blocker'), 'x');
  assert.throws(() => appendHistory(join(d, 'blocker', 'h.jsonl'), '{}'));
});

// ---- the verify template writes the history

const CONFIG = 'version: 1\nproject: history-test\ndefault_branch: main\nverify:\n  full: node scripts/verify.mjs\n  quick: node scripts/verify.mjs --quick\n  expected_steps: [a, b]\n';
const sink = () => { const parts = []; return { write: (s) => { parts.push(s); return true; }, text: () => parts.join('') }; };
const nodeCmd = (js) => `node -e "${js}"`;
const OK = nodeCmd('process.exit(0)');

async function runInRepo(steps, argv, { historyFile, env } = {}) {
  const repo = await project({ config: CONFIG });
  copyFileSync(template, join(repo.dir, 'scripts', 'verify.mjs'));
  repo.commit('verify runner');
  const { runVerify } = await import(pathToFileURL(join(repo.dir, 'scripts', 'verify.mjs')).href);
  const err = sink();
  const r = await runVerify({ argv, cwd: repo.dir, env: { PATH: process.env.PATH, ...env }, steps, lockDir: scratchDir(), historyFile, out: sink(), err });
  return { ...r, dir: repo.dir, err: err.text() };
}

test('the lib is vendored into a project and exports the agreed API', async () => {
  const repo = await project({ config: CONFIG });
  const vendored = await importVendored(repo.dir, 'lib/verify-run-history');
  assert.deepEqual(Object.keys(vendored).sort(), ['MAX_FILE_BYTES', 'MAX_LINE_BYTES', 'appendHistory', 'buildHistoryLine', 'historyPath']);
});

test('runVerify: one line per run; a failing step gives ok false, exit 1; quick and full are recorded; skip fields flow through', async () => {
  const history = join(scratchDir(), 'runs.jsonl');
  const first = await runInRepo([{ name: 'a', cmd: OK, quick: true }, { name: 'b', cmd: OK }], ['--quick'], { historyFile: history });
  const second = await runInRepo(
    [{ name: 'a', cmd: nodeCmd('process.exit(3)') }, { name: 'b', cmd: OK }], [], { historyFile: history });
  const third = await runInRepo(
    [{ name: 'a', cmd: OK, skipIf: () => ({ run: false, reason: 'unchanged' }) }, { name: 'b', cmd: OK }], [], { historyFile: history });
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 1);
  assert.equal(third.exitCode, 0);
  const [l1, l2, l3] = lines(history);
  assert.equal(lines(history).length, 3);
  assert.equal(l1.v, 1);
  assert.equal(l1.project, 'history-test');
  assert.equal(l1.dir, first.dir);
  assert.equal(l1.mode, 'quick');
  assert.equal(l1.ok, true);
  assert.equal(l1.exitCode, 0);
  assert.deepEqual(l1.steps.map((s) => s.name), ['a']);
  assert.equal(l1.startedAt, first.report.startedAt);
  assert.equal(l1.durationMs, Date.parse(first.report.finishedAt) - Date.parse(first.report.startedAt));
  assert.equal(l2.mode, 'full');
  assert.equal(l2.ok, false);
  assert.equal(l2.exitCode, 1);
  assert.deepEqual(l2.steps.map((s) => s.status), ['fail', 'not-run']);
  assert.deepEqual(l3.steps[0], { name: 'a', status: 'skipped', durationMs: l3.steps[0].durationMs, skipReason: 'unchanged' });
  assert.equal(first.err, '');
});

test('runVerify: a refused run (exit 2) is recorded with its error', async () => {
  const history = join(scratchDir(), 'runs.jsonl');
  const r = await runInRepo([{ name: 'a', cmd: OK }], [], { historyFile: history, env: { DATABASE_URL: 'postgres://u:p@db.example.com:5432/postgres' } });
  assert.equal(r.exitCode, 2);
  const [l] = lines(history);
  assert.equal(l.ok, false);
  assert.equal(l.exitCode, 2);
  assert.match(l.error, /DATABASE_URL/);
});

test('runVerify: VERIFY_RUN_HISTORY and HOME place the file when there is no override; USERPROFILE works too', async () => {
  const home = scratchDir();
  await runInRepo([{ name: 'a', cmd: OK }], [], { env: { HOME: home } });
  const std = join(home, '.claude', 'pipeline-state', 'verify-runs.jsonl');
  assert.equal(lines(std).length, 1);
  const custom = join(scratchDir(), 'custom.jsonl');
  await runInRepo([{ name: 'a', cmd: OK }], [], { env: { HOME: home, VERIFY_RUN_HISTORY: custom } });
  assert.equal(lines(custom).length, 1);
  assert.equal(lines(std).length, 1);
  const profile = scratchDir();
  await runInRepo([{ name: 'a', cmd: OK }], [], { env: { USERPROFILE: profile } });
  assert.equal(lines(join(profile, '.claude', 'pipeline-state', 'verify-runs.jsonl')).length, 1);
});

for (const [why, env] of [['CI is set', { CI: 'true' }], ['VERIFY_RUN_HISTORY is off', { VERIFY_RUN_HISTORY: 'off' }]]) {
  test(`runVerify: writes nothing when ${why}`, async () => {
    const history = join(scratchDir(), 'runs.jsonl');
    const home = scratchDir();
    const r = await runInRepo([{ name: 'a', cmd: OK }], [], { historyFile: history, env: { HOME: home, ...env } });
    assert.equal(r.exitCode, 0);
    assert.equal(existsSync(history), false);
    assert.equal(existsSync(join(home, '.claude')), false);
  });
}

test('runVerify: writes nothing (and says nothing) with no override, no VERIFY_RUN_HISTORY and no home', async () => {
  const r = await runInRepo([{ name: 'a', cmd: OK }], []);
  assert.equal(r.exitCode, 0);
  assert.equal(r.err, '');
});

test('runVerify: an unwritable history file warns on stderr and changes neither the exit code nor the report', async () => {
  const d = scratchDir();
  writeFileSync(join(d, 'blocker'), 'x');
  const r = await runInRepo([{ name: 'a', cmd: OK }], [], { historyFile: join(d, 'blocker', 'h.jsonl') });
  assert.equal(r.exitCode, 0);
  assert.equal(r.report.ok, true);
  assert.match(r.err, /^verify: run history not written: .+\n$/);
  assert.ok(statSync(join(r.dir, '.verify', 'report.json')).size > 0);
  assert.equal(JSON.parse(readFileSync(join(r.dir, '.verify', 'report.json'), 'utf8')).ok, true);
});
