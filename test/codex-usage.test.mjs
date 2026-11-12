// Why: `pipeline codex-status` tells a session how much of Codex's WEEKLY quota is gone, from Codex's own private session logs (a format that can change) and from a
// machine-global record. The reader must use only a reading that is current (R4-9) and say `unknown` otherwise, never a stale, forged or misread 0 %; the record must
// survive several sessions writing at once. Plan 2026-11-11-codex-substitute-reviewer, tests (29) and (30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWaiting, backAtMs, clearOutage, readStatus, readWeeklyUsage, recordOutage, removeWaiting, resumePrompt, statusFile } from '../pipeline/lib/codex-usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'codex-0.154', 'codex-0.154-token-count-codex.jsonl');
const REAL_LINE = readFileSync(FIXTURE, 'utf8').trim();
const REAL = JSON.parse(REAL_LINE);
const EVENT_MS = Date.parse(REAL.timestamp); // 2026-11-11T08:38:37.899Z
const NOW = EVENT_MS + 10 * 60_000;
const RESETS_MS = REAL.payload.rate_limits.primary.resets_at * 1000; // 2026-11-18T08:22:03Z

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-codex-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A CODEX_HOME with the given session files: { name: [lines], ... } under sessions/2026/11/11; `mtime` per file in ms.
const codexHome = (t, files, day = '2026/11/11') => {
  const home = join(scratch(t), '.codex');
  const dir = join(home, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  for (const [name, { lines, mtime }] of Object.entries(files)) {
    const file = join(dir, name);
    writeFileSync(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
    if (mtime !== undefined) utimesSync(file, new Date(mtime), new Date(mtime));
  }
  return home;
};
// The real event with some fields replaced.
const event = ({ at, limitId, primary, ...rest } = {}) => {
  const e = structuredClone(REAL);
  if (at !== undefined) e.timestamp = typeof at === 'number' ? new Date(at).toISOString() : at;
  if (limitId !== undefined) e.payload.rate_limits.limit_id = limitId;
  if (primary !== undefined) e.payload.rate_limits.primary = primary === null ? null : { ...e.payload.rate_limits.primary, ...primary };
  return Object.assign(e, rest);
};
const read = (home, now = NOW) => readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: home }, now });
const UNKNOWN = { weeklyUsedPct: null, windowMinutes: null, resetsAt: null, observedAt: null, source: 'unknown' };

// ---- (29) the log reader ---------------------------------------------------------------------------------------------------------------------
test('the real Codex 0.154 token_count event gives the weekly figure, with the reset and the event time as ISO strings', (t) => {
  const home = codexHome(t, { 'rollout-a.jsonl': { lines: [{ type: 'session_meta' }, REAL_LINE, { type: 'event_msg', payload: { type: 'task_complete' } }] } });
  assert.deepEqual(read(home), { weeklyUsedPct: 4, windowMinutes: 10080, resetsAt: new Date(RESETS_MS).toISOString(), observedAt: '2026-11-11T08:38:37.899Z', source: 'codex-sessions' });
});

test('a missing CODEX_HOME, an empty sessions folder and a file with no token_count are all `unknown`, never an error', (t) => {
  assert.deepEqual(read(join(scratch(t), 'nope')), UNKNOWN);
  const empty = join(scratch(t), '.codex');
  mkdirSync(join(empty, 'sessions'), { recursive: true });
  assert.deepEqual(read(empty), UNKNOWN);
  assert.deepEqual(read(codexHome(t, { 'r.jsonl': { lines: [{ type: 'session_meta' }] } })), UNKNOWN);
  assert.deepEqual(readWeeklyUsage({ env: { CODEX_HOME: '/definitely/not/here' }, now: NOW }), UNKNOWN);
  assert.doesNotThrow(() => readWeeklyUsage({ env: { CODEX_HOME: '/definitely/not/here' }, now: 'not a time' })); // a bad clock never throws
});

test('a malformed line is skipped: the valid event before and after it still counts', (t) => {
  const bad = ['{"timestamp":"2026-11-11T08:39:00.000Z","payload":{"type":"token_count"', 'not json token_count', '{"token_count": '];
  assert.equal(read(codexHome(t, { 'r.jsonl': { lines: [...bad, REAL_LINE, ...bad] } })).weeklyUsedPct, 4);
  assert.equal(read(codexHome(t, { 'r.jsonl': { lines: bad } })).source, 'unknown');
});

test('the quota-failure `premium` reading (primary: null) is ignored, not read as 0 %', (t) => {
  const premium = event({ at: EVENT_MS + 60_000, limitId: 'premium', primary: null });
  const home = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE, premium] } });
  assert.equal(read(home).weeklyUsedPct, 4, 'the later premium event does not replace the codex one');
  assert.deepEqual(read(codexHome(t, { 'r.jsonl': { lines: [premium] } })), UNKNOWN);
  const nullPrimary = event({ at: EVENT_MS + 60_000, primary: null });
  assert.deepEqual(read(codexHome(t, { 'r.jsonl': { lines: [nullPrimary] } })), UNKNOWN, 'limit_id codex with primary null is no reading either');
});

test('a reading older than 6 h is ignored; just inside 6 h is used', (t) => {
  const home = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE] } });
  assert.equal(read(home, EVENT_MS + 6 * 3600_000 + 1).source, 'unknown');
  assert.equal(read(home, EVENT_MS + 6 * 3600_000).source, 'codex-sessions');
});

test('a future-dated event is ignored beyond 5 minutes of clock skew', (t) => {
  const home = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE] } });
  assert.equal(read(home, EVENT_MS - 5 * 60_000).source, 'codex-sessions', '5 min ahead is skew');
  assert.equal(read(home, EVENT_MS - 5 * 60_000 - 1).source, 'unknown');
});

test('a window other than the week, another limit id, and an unusable percentage are ignored', (t) => {
  for (const e of [
    event({ primary: { window_minutes: 300 } }),
    event({ primary: { window_minutes: '10080' } }),
    event({ limitId: 'codex_other' }),
    event({ primary: { used_percent: '4%' } }),
    event({ primary: { used_percent: -1 } }),
    event({ primary: { used_percent: null } }),
    event({ at: 'yesterday' }),
  ]) assert.equal(read(codexHome(t, { 'r.jsonl': { lines: [e] } })).source, 'unknown', JSON.stringify(e.payload.rate_limits));
  const notToken = event(); notToken.payload.type = 'agent_message';
  const notEvent = event(); notEvent.type = 'response_item';
  for (const e of [notToken, notEvent]) assert.equal(read(codexHome(t, { 'r.jsonl': { lines: [e] } })).source, 'unknown');
});

test('a reset that is not after the event, or has already passed, makes the reading unusable', (t) => {
  const at = (resets_at) => read(codexHome(t, { 'r.jsonl': { lines: [event({ primary: { resets_at } })] } }));
  assert.equal(at(EVENT_MS / 1000).source, 'unknown', 'resets_at == event time');
  assert.equal(at(EVENT_MS / 1000 - 60).source, 'unknown', 'resets_at before the event');
  assert.equal(at('1794990123').source, 'unknown', 'resets_at not a number');
  assert.equal(at(undefined).source, 'unknown');
  // reset-boundary: a reading is current only while the reset is still ahead
  const home = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE] } });
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: home }, now: RESETS_MS - 1 }).source, 'unknown', 'older than 6 h anyway');
  const fresh = codexHome(t, { 'r.jsonl': { lines: [event({ at: RESETS_MS - 60_000 })] } });
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: fresh }, now: RESETS_MS - 1 }).source, 'codex-sessions');
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: fresh }, now: RESETS_MS }).source, 'unknown', 'at the reset instant the reset is no longer ahead');
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: fresh }, now: RESETS_MS + 1 }).source, 'unknown');
});

test('the newest event wins by its own timestamp, even when the newer-mtime file holds the older event', (t) => {
  const older = event({ at: EVENT_MS - 30 * 60_000, primary: { used_percent: 10 } });
  const newer = event({ at: EVENT_MS, primary: { used_percent: 20 } });
  const home = codexHome(t, {
    'rollout-newer-event.jsonl': { lines: [newer], mtime: NOW - 3600_000 },
    'rollout-older-event.jsonl': { lines: [older], mtime: NOW }, // the freshest file by mtime, but the staler reading
  });
  assert.equal(read(home).weeklyUsedPct, 20);
  assert.equal(read(home).observedAt, new Date(EVENT_MS).toISOString());
  // and inside one file the later event wins even when written out of order
  assert.equal(read(codexHome(t, { 'r.jsonl': { lines: [newer, older] } })).weeklyUsedPct, 20);
});

test('only the newest files by mtime are scanned (a bounded scan)', (t) => {
  const files = { 'rollout-old.jsonl': { lines: [REAL_LINE], mtime: NOW - 3 * 3600_000 } };
  for (let i = 0; i < 3; i++) files[`rollout-new-${i}.jsonl`] = { lines: [{ type: 'session_meta' }], mtime: NOW - i * 60_000 };
  const home = codexHome(t, files);
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: home }, now: NOW, maxFiles: 3 }).source, 'unknown', 'the 3 newest files hold no reading');
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: home }, now: NOW, maxFiles: 4 }).source, 'codex-sessions');
});

test('only the newest date folders are listed, and a huge file is read from its tail', (t) => {
  const home = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE] } }, '2026/11/01');
  for (const day of ['02', '03', '04', '05']) mkdirSync(join(home, 'sessions', '2026', '11', day), { recursive: true });
  assert.equal(read(home).source, 'unknown', 'five newer (empty) day folders push 11/01 out of the scan');
  assert.equal(readWeeklyUsage({ env: { PIPELINE_CODEX_HOME: home }, now: NOW, dayFolders: 10 }).source, 'codex-sessions');
  const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(4000) } });
  const big = codexHome(t, { 'r.jsonl': { lines: [REAL_LINE, ...Array(300).fill(filler)] } });
  assert.equal(read(big).source, 'unknown', 'the reading is before the last 512 KB, which is all that is read');
  const bigTail = codexHome(t, { 'r.jsonl': { lines: [...Array(300).fill(filler), REAL_LINE] } });
  assert.equal(read(bigTail).weeklyUsedPct, 4);
});

// ---- (30) the machine-global record ------------------------------------------------------------------------------------------------------------
const rec = (t) => ({ dir: join(scratch(t), 'codex') });

test('the record is empty until something is written, and an unreadable file reads as empty', (t) => {
  const o = rec(t);
  assert.deepEqual(readStatus(o), { version: 1, lastOutage: null, waiting: [] });
  mkdirSync(o.dir, { recursive: true });
  for (const junk of ['{', '[]', '"x"', 'null', '']) {
    writeFileSync(statusFile(o), junk);
    assert.deepEqual(readStatus(o), { version: 1, lastOutage: null, waiting: [] }, junk);
  }
});

test('recordOutage stores the outage; clearOutage removes it and keeps the waiting list', async (t) => {
  const o = rec(t);
  await addWaiting({ repo: 'ianjamila/claude-pipeline', pr: 256, worktree: '/w/a', round: 2, since: '2026-11-11T08:00:00Z' }, o);
  await recordOutage({ at: '2026-11-11T08:21:00Z', resetAt: '2026-11-11T16:21:00+08:00', resetText: '4:21 PM', repo: 'ianjamila/claude-pipeline', pr: 256, round: 2, worktree: '/w/a' }, o);
  const s = readStatus(o);
  assert.deepEqual(s.lastOutage, { at: '2026-11-11T08:21:00.000Z', resetAt: '2026-11-11T08:21:00.000Z', resetText: '4:21 PM', repo: 'ianjamila/claude-pipeline', pr: 256, round: 2, worktree: '/w/a' });
  await recordOutage({ at: '2026-11-11T09:00:00Z', resetAt: null, resetText: null }, o);
  assert.deepEqual(readStatus(o).lastOutage, { at: '2026-11-11T09:00:00.000Z', resetAt: null, resetText: null, repo: null, pr: null, round: null, worktree: null }, 'a later outage replaces it; unknown fields are null');
  await clearOutage(o);
  assert.equal(readStatus(o).lastOutage, null);
  assert.equal(readStatus(o).waiting.length, 1);
  assert.ok(existsSync(statusFile(o)) && readdirSync(o.dir).every((n) => !n.endsWith('.tmp')), 'no temp file is left behind');
});

test('addWaiting upserts by repo+PR, carries the resume sentence, and removeWaiting removes only that PR', async (t) => {
  const o = rec(t);
  const a = { repo: 'ianjamila/claude-pipeline', pr: 255, worktree: '/w/a', round: 1 };
  await addWaiting({ ...a, since: '2026-11-11T08:00:00Z' }, o);
  await addWaiting({ repo: 'ianjamila/eaglewatch', pr: 1818, worktree: '/w/b', round: 3, since: '2026-11-11T08:05:00Z' }, o);
  let s = readStatus(o);
  assert.deepEqual(s.waiting.map((w) => [w.repo, w.pr, w.round, w.since]), [['ianjamila/claude-pipeline', 255, 1, '2026-11-11T08:00:00.000Z'], ['ianjamila/eaglewatch', 1818, 3, '2026-11-11T08:05:00.000Z']]);
  assert.equal(s.waiting[0].resume, 'resume the review of ianjamila/claude-pipeline#255 from round 1 in /w/a');
  assert.equal(resumePrompt({ ...a, pr: 7, round: 4, worktree: '/x' }), 'resume the review of ianjamila/claude-pipeline#7 from round 4 in /x');
  // a second add for the same PR updates round/worktree and keeps the first `since`
  await addWaiting({ ...a, round: 2, worktree: '/w/a2', now: Date.parse('2026-11-11T09:00:00Z') }, o);
  s = readStatus(o);
  assert.equal(s.waiting.length, 2);
  assert.deepEqual([s.waiting[0].round, s.waiting[0].worktree, s.waiting[0].since], [2, '/w/a2', '2026-11-11T08:00:00.000Z']);
  assert.equal(s.waiting[0].resume, 'resume the review of ianjamila/claude-pipeline#255 from round 2 in /w/a2');
  // `since` defaults to now
  await addWaiting({ repo: 'r/x', pr: 1, worktree: '/w/c', round: 1, now: Date.parse('2026-11-11T09:30:00Z') }, o);
  assert.equal(readStatus(o).waiting.at(-1).since, '2026-11-11T09:30:00.000Z');
  await removeWaiting({ repo: 'ianjamila/claude-pipeline', pr: 255 }, o);
  await removeWaiting({ repo: 'no/such', pr: 9 }, o); // nothing there: a no-op
  assert.deepEqual(readStatus(o).waiting.map((w) => w.pr), [1818, 1]);
  await removeWaiting({ repo: 'ianjamila/eaglewatch', pr: 1818 }, o);
  await removeWaiting({ repo: 'r/x', pr: 1 }, o);
  assert.deepEqual(readStatus(o).waiting, []);
});

test('addWaiting and removeWaiting refuse missing or malformed fields instead of storing a record nobody can resume from', async (t) => {
  const o = rec(t);
  const ok = { repo: 'a/b', pr: 1, worktree: '/w', round: 1 };
  for (const bad of [{ repo: '' }, { pr: 0 }, { pr: '12' }, { pr: 1.5 }, { worktree: undefined }, { round: 0 }, { round: null }]) {
    await assert.rejects(addWaiting({ ...ok, ...bad }, o), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(removeWaiting({ repo: 'a/b' }, o), TypeError);
  assert.deepEqual(readStatus(o).waiting, []);
});

test('an entry with a missing field or a duplicate in a hand-edited file is dropped on read', (t) => {
  const o = rec(t);
  mkdirSync(o.dir, { recursive: true });
  const good = { repo: 'a/b', pr: 1, worktree: '/w', round: 1, since: '2026-11-11T08:00:00Z' };
  writeFileSync(statusFile(o), JSON.stringify({ waiting: [good, good, { ...good, pr: 2, round: 0 }, { ...good, pr: 3, since: 'soon' }, null, 'x'], lastOutage: { at: 'never' } }));
  const s = readStatus(o);
  assert.deepEqual(s.waiting.map((w) => w.pr), [1]);
  assert.equal(s.lastOutage, null);
});

test('concurrent writers in separate processes lose no entry and leave one valid file', async (t) => {
  const o = rec(t);
  const lib = join(here, '..', 'pipeline', 'lib', 'codex-usage.mjs');
  const script = `
    const { addWaiting, recordOutage, removeWaiting } = await import(${JSON.stringify(`file://${lib}`)});
    const [dir, who] = process.argv.slice(1);
    for (let i = 0; i < 6; i++) {
      await addWaiting({ repo: 'o/r' + who, pr: i + 1, worktree: '/w/' + who, round: 1 }, { dir });
      await addWaiting({ repo: 'o/gone' + who, pr: i + 1, worktree: '/w/' + who, round: 1 }, { dir });
      await removeWaiting({ repo: 'o/gone' + who, pr: i + 1 }, { dir });
    }
    await recordOutage({ at: '2026-11-11T08:00:00Z', repo: 'o/r' + who, pr: 1, round: 1, worktree: '/w/' + who }, { dir });`;
  const runOne = (who) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, o.dir, who], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}: ${err}`))));
  });
  await Promise.all(['a', 'b', 'c', 'd'].map(runOne));
  const s = readStatus(o);
  const keys = s.waiting.map((w) => `${w.repo}#${w.pr}`).sort();
  const want = ['a', 'b', 'c', 'd'].flatMap((who) => [1, 2, 3, 4, 5, 6].map((n) => `o/r${who}#${n}`)).sort();
  assert.deepEqual(keys, want);
  assert.ok(s.lastOutage?.repo?.startsWith('o/r'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(statusFile(o), 'utf8')));
  assert.deepEqual(readdirSync(o.dir).filter((n) => n !== 'status.json' && n !== 'codex-status.lock'), [], 'no temp files left');
});

test('the record folder honours the test seam, and a plain run points at the account\'s pipeline-state/codex folder', (t) => {
  const dir = join(scratch(t), 'seam');
  assert.equal(statusFile({ env: { PIPELINE_CODEX_STATUS_DIR: dir } }), join(dir, 'status.json'));
  assert.match(statusFile({ env: {}, home: '/home/x' }).replaceAll('\\', '/'), /^\/home\/x\/\.claude\/pipeline-state\/codex\/status\.json$/);
});

// ---- when is Codex back ----------------------------------------------------------------------------------------------------------------------
test('backAtMs: the later of the outage reset (2 h after `at` when it has none) and, at >= 100 %, the weekly reset; null when nothing is out', () => {
  const at = '2026-11-11T08:00:00.000Z';
  const reset = '2026-11-11T09:00:00.000Z';
  const nowMs = Date.parse('2026-11-11T08:30:00Z');
  assert.equal(backAtMs({ lastOutage: null, weeklyUsedPct: 50, resetsAt: reset }, nowMs), null);
  assert.equal(backAtMs({ lastOutage: null, weeklyUsedPct: null, resetsAt: null }, nowMs), null);
  assert.equal(backAtMs({ lastOutage: { at, resetAt: reset } }, nowMs), Date.parse(reset));
  assert.equal(backAtMs({ lastOutage: { at, resetAt: reset } }, Date.parse(reset)), null, 'passed (boundary)');
  assert.equal(backAtMs({ lastOutage: { at, resetAt: null } }, nowMs), Date.parse(at) + 2 * 3600_000, 'no reset time: valid for 2 h');
  assert.equal(backAtMs({ lastOutage: { at, resetAt: null } }, Date.parse(at) + 2 * 3600_000), null);
  assert.equal(backAtMs({ lastOutage: null, weeklyUsedPct: 100, resetsAt: '2026-11-18T00:00:00.000Z' }, nowMs), Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(backAtMs({ lastOutage: { at, resetAt: reset }, weeklyUsedPct: 100, resetsAt: '2026-11-18T00:00:00.000Z' }, nowMs), Date.parse('2026-11-18T00:00:00Z'));
});

// ---- R1-B1: the governor trusts only the account's own Codex home -----------------------------------------------------------------------------
test('the weekly reading comes from <account home>/.codex only: a CODEX_HOME elsewhere (a forged log) is no evidence', (t) => {
  const account = scratch(t);
  const own = join(account, '.codex', 'sessions', '2026', '11', '11');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'rollout-a.jsonl'), `${REAL_LINE}\n`);
  const forged = codexHome(t, { 'rollout-f.jsonl': { lines: [event({ primary: { used_percent: 100 } })] } });
  assert.equal(readWeeklyUsage({ env: {}, home: account, now: NOW }).weeklyUsedPct, 4, 'no CODEX_HOME: the account home is read');
  assert.equal(readWeeklyUsage({ env: { CODEX_HOME: join(account, '.codex') }, home: account, now: NOW }).weeklyUsedPct, 4, 'CODEX_HOME naming the same folder is fine');
  assert.deepEqual(readWeeklyUsage({ env: { CODEX_HOME: forged }, home: account, now: NOW }), UNKNOWN, 'CODEX_HOME elsewhere: governor off, the account log is not substituted either');
  assert.deepEqual(readWeeklyUsage({ env: { CODEX_HOME: forged }, home: join(scratch(t), 'empty'), now: NOW }), UNKNOWN);
});
