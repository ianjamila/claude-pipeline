// Why: the decisions log and its MISS / RESTART / UNKNOWN / CLEAN outcomes are the owner's only evidence for switching stopping
// on, so these tests pin the classification boundaries (exactly the would-stop time, exactly 2 h), the "any UNKNOWN blocks the
// switch-on" rule (R2-9), the per-generation dedupe, the fail-closed log reads, and the report's headline order (alerts first,
// then MISS). The integration test feeds real-shaped lsof / ps text through the real probes (evidence.mjs) into the outcome
// summary. Tmp dirs only; no real docker, ps, lsof or home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquire, release } from '../pipeline/lib/locks.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { connections, processRefs } from '../pipeline/lib/stacks/evidence.mjs';
import {
  appendDecision, readDecisions, wouldStops, classifyUse, outcomeSummary, quietCandidates, memoryOfProject, renderReport, renderWeekly, WINDOW_MS,
} from '../pipeline/lib/stacks/outcomes.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'stacks-out '));
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = '2026-10-19T03:00:00.000Z';
const T0_MS = Date.parse(T0);
const iso = (ms) => new Date(ms).toISOString();
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const gen = (n = 1, startedAt = '2026-10-18T01:00:00.000Z') => ({ id: `c${n}`, startedAt });
const dec = (o = {}) => ({ t: T0, source: 'sweep', project: 'sa-corrections', generation: gen(), mode: 'report', action: 'would-stop', reasons: ['mode report'], ...o });

// ---------------------------------------------------------------- the log

test('appendDecision is async; readDecisions reads it back; a missing file is ok([])', async () => {
  const root = tmp();
  const file = stackFiles(root).actions;
  assert.deepEqual(readDecisions(file), { ok: true, value: [] });
  const p = appendDecision(file, dec());
  assert.ok(p instanceof Promise);
  assert.equal((await p).ok, true);
  assert.equal((await appendDecision(file, dec({ t: iso(T0_MS + 1000), action: 'kept', reasons: ['x'] }))).ok, true);
  const r = readDecisions(file);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((d) => d.action), ['would-stop', 'kept']);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('appendDecision refuses a record without a valid ISO time, project or action; nothing is written', async () => {
  const file = stackFiles(tmp()).actions;
  assert.equal((await appendDecision(file, dec({ t: 'yesterday' }))).ok, false);
  assert.equal((await appendDecision(file, dec({ project: '' }))).ok, false);
  assert.equal((await appendDecision(file, dec({ action: undefined }))).ok, false);
  assert.equal((await appendDecision(file, null)).ok, false);
  assert.equal(existsSync(file), false);
});

test('appendDecision shrinks an oversized evidence blob instead of losing the decision', async () => {
  const file = stackFiles(tmp()).actions;
  const big = dec({ evidence: { connections: Array.from({ length: 400 }, (_, i) => ({ pid: i, command: 'node '.repeat(10) })) } });
  const r = await appendDecision(file, big);
  assert.equal(r.ok, true, r.reason);
  const back = readDecisions(file).value[0];
  assert.equal(back.action, 'would-stop');
  assert.equal(back.evidence.truncated, true);
});

test('appendDecision uses its own lock: a held ledger lock does not delay it', async () => {
  const root = tmp();
  const file = stackFiles(root).actions;
  const held = await acquire('ledger', { dir: lockDirs(root).ledger, waitMs: 1000, pollMs: 10 });
  try {
    const r = await appendDecision(file, dec(), { waitMs: 150, pollMs: 10 });
    assert.equal(r.ok, true, r.reason);
  } finally {
    release(held);
  }
});

test('readDecisions: a damaged line makes the whole log unknown (never a partial answer)', () => {
  const file = stackFiles(tmp()).actions;
  writeFileSync(file, `${JSON.stringify(dec())}\n{broken\n`);
  const r = readDecisions(file);
  assert.equal(r.ok, false);
  assert.match(r.reason, /line 2/);
  const torn = stackFiles(tmp()).actions;
  writeFileSync(torn, JSON.stringify(dec())); // no trailing newline
  assert.equal(readDecisions(torn).ok, false);
});

// ---------------------------------------------------------------- wouldStops

test('wouldStops: three sweeps of one generation give one record, first wins, lastSeen moves', () => {
  const ds = [0, 1, 2].map((i) => dec({ t: iso(T0_MS + i * DAY), source: i === 0 ? 'session-end' : 'sweep', memBytes: (i + 1) * GIB }));
  const m = wouldStops(ds);
  assert.equal(m.size, 1);
  const rec = [...m.values()][0];
  assert.equal(rec.t, T0);
  assert.equal(rec.source, 'session-end');
  assert.equal(rec.memBytes, GIB, 'first wins, later sweeps do not replace it');
  assert.equal(rec.lastSeen, iso(T0_MS + 2 * DAY));
  assert.equal([...m.keys()][0], `sa-corrections|c1|2026-10-18T01:00:00.000Z`);
});

test('wouldStops: a restarted container (new StartedAt) is a new would-stop; kept/failed records are not would-stops', () => {
  const ds = [
    dec(),
    dec({ t: iso(T0_MS + HOUR), generation: gen(1, '2026-10-19T03:30:00.000Z') }),
    dec({ t: iso(T0_MS + 2 * HOUR), action: 'kept' }),
    dec({ t: iso(T0_MS + 3 * HOUR), action: 'failed' }),
    dec({ t: iso(T0_MS + 4 * HOUR), project: 'other', action: 'stopped', generation: gen(2) }),
  ];
  const m = wouldStops(ds);
  assert.deepEqual([...m.keys()].sort(), ['other|c2|2026-10-18T01:00:00.000Z', 'sa-corrections|c1|2026-10-18T01:00:00.000Z', 'sa-corrections|c1|2026-10-19T03:30:00.000Z']);
  assert.equal(m.get('sa-corrections|c1|2026-10-18T01:00:00.000Z').lastSeen, T0, 'a kept record does not move lastSeen');
});

test('wouldStops: project ids compare case-insensitively', () => {
  const m = wouldStops([dec({ project: 'DRMed-x' }), dec({ project: 'drmed-x', t: iso(T0_MS + HOUR) })]);
  assert.equal(m.size, 1);
});

// ---------------------------------------------------------------- classifyUse (R2-9)

const rec0 = dec();
const born = (ms) => Math.floor(ms / 1000);

test('classifyUse: MISS needs a birth before the would-stop; at exactly the would-stop time it is a RESTART', () => {
  const use = (o) => ({ t: iso(T0_MS + 10 * 60_000), pid: 5, birth: born(T0_MS) - 1, ...o });
  assert.equal(classifyUse(rec0, use({ birth: born(T0_MS) - 1 })), 'MISS');
  assert.equal(classifyUse(rec0, use({ birth: born(T0_MS) })), 'RESTART', 'born exactly at the would-stop time is not before it');
  assert.equal(classifyUse(rec0, use({ birth: born(T0_MS) + 60 })), 'RESTART');
});

test('classifyUse: the window is 0..2 h after the would-stop, inclusive of both ends', () => {
  assert.equal(WINDOW_MS, 2 * HOUR);
  const base = { pid: 5, birth: born(T0_MS) - 100 };
  assert.equal(classifyUse(rec0, { ...base, t: T0 }), 'MISS', 'a use at exactly the would-stop time counts');
  assert.equal(classifyUse(rec0, { ...base, t: iso(T0_MS + 2 * HOUR) }), 'MISS', 'exactly 2 h counts');
  assert.equal(classifyUse(rec0, { ...base, t: iso(T0_MS + 2 * HOUR + 1) }), null);
  assert.equal(classifyUse(rec0, { ...base, t: iso(T0_MS - 1) }), null, 'before the would-stop is not an outcome');
});

test('classifyUse: no identity (birth null / missing / NaN) is UNKNOWN inside the window, null outside it', () => {
  const t = iso(T0_MS + HOUR);
  for (const birth of [null, undefined, Number.NaN]) assert.equal(classifyUse(rec0, { t, pid: 5, birth }), 'UNKNOWN');
  assert.equal(classifyUse(rec0, { t, pid: null, birth: null }), 'UNKNOWN', 'a hidden client has no identity at all');
  assert.equal(classifyUse(rec0, { t: iso(T0_MS + 3 * HOUR), pid: 5, birth: null }), null);
  assert.equal(classifyUse(rec0, { t: 'garbage', pid: 5, birth: 1 }), 'UNKNOWN', 'an unplaceable use is never ignored');
  assert.equal(classifyUse({ ...rec0, t: 'garbage' }, { t, pid: 5, birth: 1 }), 'UNKNOWN');
  assert.equal(classifyUse(rec0, null), null);
});

// ---------------------------------------------------------------- outcomeSummary

const NOW = T0_MS + 3 * HOUR; // every 2 h window below is over, except where a test says so
const useAt = (offsetMs, o = {}) => ({ t: iso(T0_MS + offsetMs), project: 'sa-corrections', pid: 7, birth: born(T0_MS) - 500, check: 'connection', command: 'node', ...o });

test('outcomeSummary: MISS, RESTART, UNKNOWN, CLEAN and PENDING are counted per would-stop, the worst class wins', () => {
  const ds = [
    dec({ project: 'miss', generation: gen(1), memBytes: 512 * MIB }),
    dec({ project: 'restart', generation: gen(2), memBytes: GIB }),
    dec({ project: 'unk', generation: gen(3) }),
    dec({ project: 'clean', generation: gen(4), memBytes: 2 * GIB }),
    dec({ project: 'mixed', generation: gen(5) }),
    dec({ project: 'fresh', generation: gen(6), t: iso(NOW - 10 * 60_000) }),
  ];
  const uses = [
    useAt(10 * 60_000, { project: 'miss' }),
    useAt(20 * 60_000, { project: 'restart', birth: born(T0_MS) + 300 }),
    useAt(20 * 60_000, { project: 'unk', birth: null, pid: null }),
    useAt(10 * 60_000, { project: 'mixed', birth: born(T0_MS) + 300 }),
    useAt(30 * 60_000, { project: 'mixed', birth: null }),
    useAt(40 * 60_000, { project: 'mixed' }), // a MISS beats the unknown and the restart
    useAt(2.5 * HOUR, { project: 'clean' }), // outside the window: not an outcome
    useAt(-HOUR, { project: 'clean' }), // before the would-stop: not an outcome
    useAt(10 * 60_000, { project: 'someone-else' }), // another project
  ];
  const s = outcomeSummary(ds, uses, NOW);
  assert.deepEqual([s.miss, s.restart, s.unknown, s.clean, s.pending], [2, 1, 1, 1, 1]);
  const byProject = Object.fromEntries(s.rows.map((r) => [r.project, r.outcome]));
  assert.deepEqual(byProject, { miss: 'MISS', restart: 'RESTART', unk: 'UNKNOWN', clean: 'CLEAN', mixed: 'MISS', fresh: 'PENDING' });
});

test('outcomeSummary: gbFreed sums mixed MiB / GiB bytes over the counted would-stops', () => {
  const ds = [dec({ project: 'a', memBytes: 512 * MIB }), dec({ project: 'b', memBytes: 1.5 * GIB }), dec({ project: 'c' })];
  const s = outcomeSummary(ds, [], NOW);
  assert.equal(s.gbFreed, 2);
  assert.equal(s.clean, 3);
});

test('outcomeSummary: only the last 7 days of would-stops count; a use finds the newest generation before it', () => {
  const old = dec({ project: 'old', t: iso(NOW - 8 * DAY) });
  const edge = dec({ project: 'edge', t: iso(NOW - 7 * DAY) });
  const s = outcomeSummary([old, edge], [], NOW);
  assert.deepEqual(s.rows.map((r) => r.project), ['edge']);
  const first = dec({ generation: gen(1) });
  const second = dec({ t: iso(T0_MS + 10 * HOUR), generation: gen(1, '2026-10-19T12:00:00.000Z') });
  const u = useAt(10 * HOUR + 5 * 60_000, { birth: born(T0_MS + 10 * HOUR) + 5 });
  const s2 = outcomeSummary([first, second], [u], T0_MS + 20 * HOUR);
  assert.deepEqual(s2.rows.map((r) => r.outcome), ['CLEAN', 'RESTART']);
});

test('outcomeSummary: repeated sweeps of a generation never add a would-stop (one row, lastSeen moves); a use is judged from the newest record', () => {
  const ds = [0, 1, 2].map((i) => dec({ t: iso(T0_MS + i * HOUR) }));
  const s = outcomeSummary(ds, [useAt(10 * HOUR)], T0_MS + 12 * HOUR);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].lastSeen, iso(T0_MS + 2 * HOUR));
  assert.equal(s.clean, 1, 'a use 8 h after the NEWEST record is outside its window');
  const near = outcomeSummary(ds, [useAt(2.5 * HOUR)], T0_MS + 5 * HOUR);
  assert.equal(near.rows.length, 1);
  assert.equal(near.rows[0].outcome, 'MISS', 'a use 30 min after the 3rd record of the generation is its MISS, not "2.5 h after the first"');
  assert.equal(near.rows[0].lastSeen, iso(T0_MS + 2 * HOUR));
});

test('outcomeSummary (F1): a would-stop of a days-old generation repeated on day 3, with a use 30 min later, is a MISS, not CLEAN', () => {
  const ds = [dec({ t: iso(T0_MS) }), dec({ t: iso(T0_MS + 2 * DAY), source: 'session-end' })];
  const u = useAt(2 * DAY + 30 * 60_000, { birth: born(T0_MS) - 5 * DAY });
  const s = outcomeSummary(ds, [u], T0_MS + 2 * DAY + 5 * HOUR);
  assert.equal(s.rows.length, 1, 'still one row per generation');
  assert.deepEqual([s.miss, s.clean], [1, 0]);
  assert.equal(s.rows[0].uses.length, 1);
  assert.equal(s.rows[0].uses[0].against, iso(T0_MS + 2 * DAY));
  assert.match(renderReport(baseState({ now: T0_MS + 2 * DAY + 5 * HOUR, decisions: ds, uses: [u] })), /would-stop 2026-10-21T03:00:00.000Z/);
});

test('outcomeSummary (F1): the row takes the worst class over all its records; CLEAN needs the NEWEST record\'s window to be over with no use', () => {
  const ds = [dec({ t: iso(T0_MS) }), dec({ t: iso(T0_MS + DAY) }), dec({ t: iso(T0_MS + 2 * DAY) })];
  const restart = useAt(DAY + 10 * 60_000, { birth: born(T0_MS + DAY) + 1 }); // a restart after the 2nd record
  const miss = useAt(10 * 60_000); // a MISS after the 1st record
  const all = outcomeSummary(ds, [restart, miss], T0_MS + 4 * DAY);
  assert.deepEqual(all.rows.map((r) => r.outcome), ['MISS']);
  assert.equal(outcomeSummary(ds, [restart], T0_MS + 4 * DAY).rows[0].outcome, 'RESTART');
  assert.equal(outcomeSummary(ds, [], T0_MS + 2 * DAY + HOUR).rows[0].outcome, 'PENDING', 'the newest record is still inside its window');
  assert.equal(outcomeSummary(ds, [], T0_MS + 2 * DAY + 3 * HOUR).rows[0].outcome, 'CLEAN');
});

test('outcomeSummary (F1): a generation first seen over 7 days ago but would-stopped again within them is still reported', () => {
  const ds = [dec({ t: iso(NOW - 9 * DAY) }), dec({ t: iso(NOW - 2 * DAY) })];
  const s = outcomeSummary(ds, [], NOW);
  assert.equal(s.rows.length, 1);
});

// ---- F2: CLEAN needs an observer's word for a session-end would-stop

const se = (o = {}) => dec({ source: 'session-end', ...o });
// decidedAt (R4-B1) defaults to the first would-stop's t: the decision record the marker observed.
const mark = (action, offset, o = {}) => ({ t: iso(T0_MS + offset), source: 'session-end', project: 'sa-corrections', generation: gen(), action, reasons: ['r'], decidedAt: T0, ...o });

test('outcomeSummary (F2): a session-end would-stop with an `observed` record after the window is CLEAN', () => {
  const s = outcomeSummary([se(), mark('observed', 2 * HOUR)], [], T0_MS + 3 * HOUR);
  assert.deepEqual([s.clean, s.unknown, s.rows.length], [1, 0, 1], 'markers add no row and are not would-stops');
  assert.deepEqual(wouldStops([se(), mark('observed', 2 * HOUR)]).size, 1);
});

test('outcomeSummary (F2): a session-end would-stop with no observation is UNKNOWN once its window is over (PENDING before)', () => {
  assert.equal(outcomeSummary([se()], [], T0_MS + HOUR).rows[0].outcome, 'PENDING');
  const s = outcomeSummary([se()], [], T0_MS + 3 * HOUR);
  assert.deepEqual([s.clean, s.unknown], [0, 1]);
  assert.match(s.rows[0].note, /no re-probe was recorded/);
  const text = renderReport(baseState({ now: T0_MS + 3 * HOUR, decisions: [se()] }));
  assert.match(text, /MISS 0 \(\+1 unknown ⇒ not yet\)/);
  assert.match(text, /sa-corrections — stack run .* — UNKNOWN: 1 would-stop decision, 0 uses — no re-probe was recorded/);
  assert.match(text, /Switch-on: not yet/);
});

test('outcomeSummary (F2): observation-late and observation-lost are UNKNOWN; an observed record of an OLDER record of the generation does not vouch for the newest', () => {
  assert.equal(outcomeSummary([se(), mark('observation-late', 3 * HOUR)], [], T0_MS + 4 * HOUR).rows[0].outcome, 'UNKNOWN');
  const lost = outcomeSummary([se(), mark('observation-lost', 40 * 60_000)], [], T0_MS + 4 * HOUR);
  assert.equal(lost.rows[0].outcome, 'UNKNOWN');
  assert.match(lost.rows[0].note, /worker died/);
  const ds = [se(), mark('observed', 2 * HOUR), se({ t: iso(T0_MS + DAY) })];
  assert.equal(outcomeSummary(ds, [], T0_MS + DAY + 3 * HOUR).rows[0].outcome, 'UNKNOWN');
  assert.equal(outcomeSummary([...ds, mark('observed', DAY + 2 * HOUR, { decidedAt: iso(T0_MS + DAY) })], [], T0_MS + DAY + 3 * HOUR).rows[0].outcome, 'CLEAN');
});

test('outcomeSummary (F2): a use still wins (MISS), and a sweep-sourced would-stop keeps its CLEAN rule (the sweep has no observer)', () => {
  assert.equal(outcomeSummary([se(), mark('observation-lost', HOUR)], [useAt(10 * 60_000)], T0_MS + 4 * HOUR).rows[0].outcome, 'MISS');
  const s = outcomeSummary([dec()], [], T0_MS + 4 * HOUR);
  assert.deepEqual([s.clean, s.unknown], [1, 0]);
});

// ---- R4-B1: a marker is bound to the decision record it observed

test('outcomeSummary (R4-B1): session A\'s `observed` does not vouch for session B\'s later would-stop of the same generation', () => {
  const A = se({ t: iso(T0_MS) });
  const B = se({ t: iso(T0_MS + HOUR) });
  const now = T0_MS + 10 * HOUR; // 13:01 in the report's terms: B's window is long over
  const onlyA = outcomeSummary([A, B, mark('observed', 9 * HOUR, { decidedAt: A.t })], [], now);
  assert.deepEqual([onlyA.clean, onlyA.unknown], [0, 1], 'A\'s marker is not B\'s');
  assert.match(onlyA.rows[0].note, /no re-probe was recorded/);
  const both = outcomeSummary([A, B, mark('observed', 9 * HOUR, { decidedAt: A.t }), mark('observed', 3 * HOUR, { decidedAt: B.t })], [], now);
  assert.deepEqual([both.clean, both.unknown], [1, 0], 'B\'s own observed makes it CLEAN');
  // a marker with no decidedAt (older format) never counts as observed
  assert.equal(outcomeSummary([A, mark('observed', 2 * HOUR, { decidedAt: undefined })], [], T0_MS + 3 * HOUR).rows[0].outcome, 'UNKNOWN');
});

test('outcomeSummary (R4-B1): a delayed observation-lost / -late of an OLDER record is not charged to the newer one; one without decidedAt counts only when not older than the newest record', () => {
  const A = se({ t: iso(T0_MS) });
  const B = se({ t: iso(T0_MS + HOUR) });
  const withB = (extra) => outcomeSummary([A, B, mark('observed', 3 * HOUR, { decidedAt: B.t }), extra], [], T0_MS + 10 * HOUR).rows[0];
  assert.equal(withB(mark('observation-lost', 5 * HOUR, { decidedAt: A.t })).outcome, 'CLEAN', 'A\'s lost does not taint B');
  assert.equal(withB(mark('observation-lost', 5 * HOUR, { decidedAt: B.t })).outcome, 'UNKNOWN');
  assert.equal(withB(mark('observation-lost', 5 * HOUR, { decidedAt: undefined })).outcome, 'UNKNOWN', 'no decidedAt, newer than B: conservative');
  assert.equal(withB(mark('observation-lost', 30 * 60_000, { decidedAt: undefined })).outcome, 'CLEAN', 'no decidedAt, older than B: not B\'s');
});

// ---- R4-B2: an incomplete observation outranks RESTART (but not MISS)

test('outcomeSummary (R4-B2): RESTART + observation-lost / no observation after the window is UNKNOWN; RESTART + observed, or inside an open window with no marker, stays RESTART', () => {
  const restart = useAt(30 * 60_000, { birth: born(T0_MS) + 300 });
  const lost = outcomeSummary([se(), mark('observation-lost', 40 * 60_000)], [restart], T0_MS + 4 * HOUR);
  assert.equal(lost.rows[0].outcome, 'UNKNOWN');
  assert.deepEqual([lost.unknown, lost.restart], [1, 0]);
  assert.match(lost.rows[0].note, /worker died/);
  const none = outcomeSummary([se()], [restart], T0_MS + 2 * HOUR);
  assert.deepEqual([none.unknown, none.restart], [1, 0], 'now >= +2 h and nobody observed');
  assert.match(none.rows[0].note, /no re-probe was recorded/);
  assert.equal(outcomeSummary([se(), mark('observed', 2 * HOUR)], [restart], T0_MS + 3 * HOUR).rows[0].outcome, 'RESTART');
  assert.equal(outcomeSummary([se()], [restart], T0_MS + HOUR).rows[0].outcome, 'RESTART', 'window still open, no lost / late marker');
  assert.equal(outcomeSummary([se(), mark('observation-late', 3 * HOUR)], [restart], T0_MS + 4 * HOUR).rows[0].outcome, 'UNKNOWN');
  assert.equal(outcomeSummary([se(), mark('observation-lost', HOUR)], [restart, useAt(10 * 60_000)], T0_MS + 4 * HOUR).rows[0].outcome, 'MISS', 'MISS outranks UNKNOWN');
});

// ---------------------------------------------------------------- memoryOfProject

const stats = (rows, extra = {}) => (cmd, args) => {
  assert.deepEqual(args, ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
  return { code: 0, stdout: rows.join('\n') + '\n', stderr: '', timedOut: false, signal: null, ...extra };
};

test('memoryOfProject: sums the project containers, parses B / KiB / MiB / GiB, ignores other projects', () => {
  const run = stats([
    'supabase_db_sa-corrections\t512.5MiB / 7.6GiB',
    'supabase_kong_sa-corrections\t1.25GiB / 7.6GiB',
    'supabase_pg_meta_sa-corrections\t100KiB / 7.6GiB',
    'supabase_vector_sa-corrections\t2048B / 7.6GiB',
    'supabase_db_sa-corrections-followups\t900MiB / 7.6GiB',
    'supabase_db_other_sa-corrections\t900MiB / 7.6GiB',
    'unrelated\t5GiB / 7.6GiB',
  ]);
  const r = memoryOfProject('SA-Corrections', { run, docker: '/fake/docker' });
  assert.equal(r.ok, true);
  assert.equal(r.value, Math.round(512.5 * MIB + 1.25 * GIB + 100 * 1024 + 2048));
});

test('memoryOfProject: failure, timeout, no containers or an unparsable figure is unknown', () => {
  assert.equal(memoryOfProject('p', { run: stats([], { code: 1, stderr: 'Cannot connect' }) }).ok, false);
  assert.equal(memoryOfProject('p', { run: stats([], { timedOut: true, code: 124 }) }).ok, false);
  assert.equal(memoryOfProject('p', { run: stats([], { signal: 'SIGKILL' }) }).ok, false);
  assert.equal(memoryOfProject('p', { run: stats(['supabase_db_other\t1MiB / 2GiB']) }).ok, false);
  assert.equal(memoryOfProject('p', { run: stats(['supabase_db_p\tNaN / 2GiB']) }).ok, false);
  assert.equal(memoryOfProject('p', { run: () => { throw new Error('ENOENT'); } }).ok, false);
});

// ---------------------------------------------------------------- reports

const baseState = (o = {}) => ({ now: NOW, decisions: [], uses: [], ...o });
const headlineIndex = (text, re) => text.search(re);

test('renderReport: a clean report leads with "MISS 0 (must be 0 to switch on)" then RESTART, CLEAN, GB freed', () => {
  const text = renderReport(baseState({ decisions: [dec({ memBytes: GIB })], ledger: { ok: true }, config: 'ok' }));
  assert.match(text, /MISS 0 \(must be 0 to switch on\)/);
  const order = [/MISS 0/, /RESTART 0/, /CLEAN 1/, /GB freed 1\.00/].map((re) => headlineIndex(text, re));
  assert.ok(order.every((i) => i >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'headline order');
  assert.doesNotMatch(text, /P stacks repair/);
});

test('renderReport: any UNKNOWN blocks the switch-on recommendation (R2-9)', () => {
  const ds = [dec({ project: 'a' }), dec({ project: 'b', generation: gen(2) })];
  const us = [useAt(HOUR, { project: 'a', birth: null }), useAt(HOUR, { project: 'b', birth: null, pid: null })];
  const text = renderReport(baseState({ decisions: ds, uses: us }));
  assert.match(text, /MISS 0 \(\+2 unknown ⇒ not yet\)/);
  assert.doesNotMatch(text, /must be 0 to switch on/);
});

test('renderReport: MISS rows name the stack, the process and the check that missed it', () => {
  const text = renderReport(baseState({ decisions: [dec()], uses: [useAt(HOUR, { pid: 4321, command: 'psql postgres://127.0.0.1:54422/db', check: 'connection' })] }));
  assert.match(text, /MISS 1 \(must be 0 to switch on\)/);
  assert.match(text, /sa-corrections/);
  assert.match(text, /4321/);
  assert.match(text, /psql postgres/);
  assert.match(text, /connection/);
});

test('renderReport (R2-8): a db-volume-missing decision is a headline BEFORE MISS; post-check-unknown is listed too', () => {
  const ds = [
    dec({ project: 'gone', action: 'stopped', alert: 'db-volume-missing', reasons: ['db volume supabase_db_gone is missing after the stop'], generation: gen(2) }),
    dec({ project: 'maybe', action: 'stopped', alert: 'post-check-unknown', reasons: ['post-check incomplete: docker timed out'], generation: gen(3) }),
  ];
  const text = renderReport(baseState({ decisions: ds }));
  const volume = text.search(/db-volume-missing/);
  const unknownCheck = text.search(/post-check-unknown/);
  const miss = text.search(/MISS 0/);
  assert.ok(volume >= 0 && unknownCheck >= 0 && miss >= 0, text);
  assert.ok(volume < miss, 'volume alert comes before MISS');
  assert.ok(volume < unknownCheck, 'the data-loss alert is the first line');
  assert.match(text, /gone/);
  assert.match(text, /maybe/);
});

test('renderReport: dangling hook files, damaged ledger with the repair hint, not-configured and pause are stated', () => {
  const text = renderReport(baseState({
    config: 'missing',
    paused: true,
    hooks: [{ file: '/home/u/.claude/pipeline/hooks/stack-register.mjs', problem: 'missing' }],
    ledger: { ok: false, reason: 'damaged ledger line 3: not JSON' },
  }));
  assert.match(text, /not configured/i);
  assert.match(text, /paused/i);
  assert.match(text, /stack-register\.mjs/);
  assert.match(text, /damaged ledger line 3/);
  assert.match(text, /P stacks repair/);
  assert.match(text, /stopping (is )?disabled/i);
});

test('renderReport: listed stacks show their blockers and hidden: N notes; dev rows are listed after them', () => {
  const text = renderReport(baseState({
    listed: [
      { project: 'sa-corrections', verdict: 'kept', reasons: ['live lease: claude 4242', 'connection from node 77'], hidden: 3 },
      { project: 'drmed-x', verdict: 'listed', reasons: ['workdir unknown (report-only)'] },
    ],
    dev: [{ port: 3000, pid: 99, cwd: '/w/web', worktree: '/w/web', uptimeS: 7200, boundOwnerAlive: false, verdict: 'orphan candidate' }],
  }));
  assert.match(text, /sa-corrections.*live lease: claude 4242/s);
  assert.match(text, /hidden: 3/);
  assert.doesNotMatch(text, /drmed-x[^\n]*hidden: /);
  assert.match(text, /workdir unknown/);
  const listed = text.search(/sa-corrections.*live lease/s);
  const dev = text.search(/orphan candidate/);
  assert.ok(listed >= 0 && dev > listed, 'dev rows after the listed stacks');
  assert.match(text, /3000/);
});

test('renderReport: sections follow the spec order', () => {
  const text = renderReport(baseState({
    decisions: [dec({ project: 'v', action: 'stopped', alert: 'db-volume-missing', generation: gen(9) }), dec()],
    uses: [useAt(HOUR)],
    hooks: [{ file: 'h.mjs', problem: 'missing' }],
    ledger: { ok: false, reason: 'damaged ledger line 1' },
    listed: [{ project: 'listed-stack', verdict: 'listed', reasons: ['r'] }],
    dev: [{ port: 3000, pid: 1, cwd: '/c', worktree: '/c', uptimeS: 1, boundOwnerAlive: true, verdict: 'owned' }],
  }));
  const marks = [/db-volume-missing/, /MISS 1/, /RESTART 0/, /CLEAN \d/, /GB freed/, /h\.mjs/, /P stacks repair/, /listed-stack/, /Dev servers/].map((re) => text.search(re));
  assert.ok(marks.every((i) => i >= 0), JSON.stringify(marks));
  assert.deepEqual([...marks].sort((a, b) => a - b), marks);
});

test('renderWeekly: only the last 7 days appear (counts, alerts), with the link to the sweep report', () => {
  const old = dec({ project: 'ancient-stack', t: iso(NOW - 9 * DAY), generation: gen(7), action: 'stopped', alert: 'db-volume-missing' });
  const recent = dec({ project: 'recent-stack', t: iso(NOW - 2 * DAY), generation: gen(8), memBytes: GIB });
  const text = renderWeekly(baseState({
    decisions: [old, recent],
    uses: [useAt(-9 * DAY + HOUR, { project: 'ancient-stack' })],
    reportPath: '/s/report.md',
    listed: [{ project: 'listed-one', verdict: 'listed', reasons: ['no owner'] }],
    dev: [{ port: 3000, pid: 1, cwd: '/c', worktree: '/c', uptimeS: 1, boundOwnerAlive: false, verdict: 'orphan candidate' }],
  }));
  assert.doesNotMatch(text, /ancient-stack/);
  assert.doesNotMatch(text, /db-volume-missing/);
  assert.match(text, /recent-stack/);
  assert.match(text, /MISS 0/);
  assert.match(text, /CLEAN 1/);
  assert.match(text, /1\.00 GB/);
  assert.match(text, /listed-one/);
  assert.match(text, /orphan candidate/);
  assert.match(text, /\/s\/report\.md/);
});

// ---------------------------------------------------------------- R2-9 integration: probe text -> uses -> summary

const PS = '/fake/ps';
const LSOF = '/fake/lsof';
const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, pid: 7001, ...o });
const esrch = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
const text = (...parts) => `${parts.flat().join('\n')}\n`;
const BEFORE = 'Mon Oct 19 02:47:17 2026'; // 13 min before the would-stop at 03:00:00 UTC
const AFTER = 'Mon Oct 19 03:10:00 2026';

function machine({ lstart = {}, lsofOut, psCmd = [], psEnv = [] }) {
  return (cmd, args = [], opts = {}) => {
    if (cmd === PS && args[0] === '-o' && args[1] === 'lstart=') {
      const pid = args[3];
      return pid in lstart ? res({ stdout: `${lstart[pid]}\n`, pid: 7900 }) : res({ code: 1, pid: 7900 });
    }
    if (cmd === LSOF) return res({ stdout: lsofOut });
    if (cmd === PS && args[0] === '-axE') {
      const nonce = opts.env.PIPELINE_STACKS_PROBE;
      return res({ pid: 7002, stdout: text(psEnv, [`7002 /bin/ps -axE -ww -o pid=,command= PIPELINE_STACKS_PROBE=${nonce}`]) });
    }
    if (cmd === PS && args[0] === '-axww') return res({ pid: 7001, stdout: text(psCmd, ['  7001   501 /bin/ps -axww -o pid=,uid=,command=']) });
    return res({ code: 1, stderr: `unexpected ${cmd}` });
  };
}

const helper = (port) => ['p1201', 'cOrbStack Helper', 'f20', `n*:${port}`, 'TST=LISTEN'];
const server = (client, port) => ['p1201', 'cOrbStack Helper', 'f30', `n127.0.0.1:${port}->127.0.0.1:${client}`, 'TST=ESTABLISHED'];
const client = (pid, cmd, port, local) => [`p${pid}`, `c${cmd}`, 'f15', `n127.0.0.1:${local}->127.0.0.1:${port}`, 'TST=ESTABLISHED'];

test('integration (R2-9): fake lsof / ps output -> re-probe -> uses -> outcome summary counts MISS / RESTART / UNKNOWN', () => {
  const stacks = {
    miss: { project: 'miss-stack', folder: 'miss-stack.stack', workdir: '/Users/me/My Stacks/miss-stack.stack', ports: [54431] },
    restart: { project: 'restart-stack', folder: 'restart-stack.stack', workdir: '/Users/me/My Stacks/restart-stack.stack', ports: [54441] },
    unknown: { project: 'unknown-stack', folder: 'unknown-stack.stack', workdir: '/Users/me/My Stacks/unknown-stack.stack', ports: [54451] },
    hidden: { project: 'hidden-stack', folder: 'hidden-stack.stack', workdir: '/Users/me/My Stacks/hidden-stack.stack', ports: [54461] },
    ref: { project: 'ref-stack', folder: 'ref-stack.stack', workdir: '/Users/me/My Stacks/ref-stack.stack', ports: [] },
  };
  const probeAt = iso(T0_MS + 30 * 60_000); // the worker's +30 min re-probe
  const conn = (stack, lsofOut, lstart) => connections(stack, { run: machine({ lsofOut, lstart }), lsof: LSOF, ps: PS, platform: 'darwin', kill: esrch });
  const port = (s) => s.ports[0];
  const found = {
    miss: conn(stacks.miss, text(helper(port(stacks.miss)), server(61001, port(stacks.miss)), client(9001, 'node', port(stacks.miss), 61001)), { 9001: BEFORE }),
    restart: conn(stacks.restart, text(helper(port(stacks.restart)), server(61002, port(stacks.restart)), client(9002, 'psql', port(stacks.restart), 61002)), { 9002: AFTER }),
    unknown: conn(stacks.unknown, text(helper(port(stacks.unknown)), server(61003, port(stacks.unknown)), client(9003, 'node', port(stacks.unknown), 61003)), {}), // ps cannot name its birth
    hidden: conn(stacks.hidden, text(helper(port(stacks.hidden)), server(61004, port(stacks.hidden))), {}), // another user's client: no client socket visible
  };
  for (const r of Object.values(found)) assert.equal(r.ok, true, r.reason);
  const refs = processRefs(stacks.ref, {
    run: machine({
      lstart: { 4002: BEFORE },
      psCmd: [' 4002   501 supabase start --workdir /Users/me/My Stacks/ref-stack.stack'],
      psEnv: [' 4002 supabase start --workdir /Users/me/My Stacks/ref-stack.stack HOME=/Users/me'],
    }),
    ps: PS, platform: 'darwin', uid: 501, kill: esrch, nonce: 'n0nce',
  });
  assert.equal(refs.ok, true, refs.reason);

  const toUses = (project, hits, check) => hits.map((h) => ({ t: probeAt, project, pid: h.pid, birth: h.birth, command: h.command, check }));
  const uses = [
    ...toUses('miss-stack', found.miss.value, 'connection'),
    ...toUses('restart-stack', found.restart.value, 'connection'),
    ...toUses('unknown-stack', found.unknown.value, 'connection'),
    ...toUses('hidden-stack', found.hidden.value, 'connection'),
    ...toUses('ref-stack', refs.value, 'process-ref'),
  ];
  assert.equal(uses.length, 5);
  assert.equal(uses.find((u) => u.project === 'hidden-stack').pid, null);
  const ds = Object.values(stacks).map((s, i) => dec({ project: s.project, generation: gen(i + 1) }));
  const summary = outcomeSummary(ds, uses, NOW);
  assert.deepEqual([summary.miss, summary.restart, summary.unknown, summary.clean], [2, 1, 2, 0]);
  const byProject = Object.fromEntries(summary.rows.map((r) => [r.project, r.outcome]));
  assert.deepEqual(byProject, { 'miss-stack': 'MISS', 'restart-stack': 'RESTART', 'unknown-stack': 'UNKNOWN', 'hidden-stack': 'UNKNOWN', 'ref-stack': 'MISS' });
  const report = renderReport({ now: NOW, decisions: ds, uses });
  assert.match(report, /MISS 2 \(\+2 unknown ⇒ not yet\)/);
});

test('a decisions log written by appendDecision survives a torn tail only as unknown', async () => {
  const file = stackFiles(tmp()).actions;
  await appendDecision(file, dec());
  appendFileSync(file, '{"t":"2026-10-19T03:00:00.000Z","project":"x"');
  assert.equal(readDecisions(file).ok, false);
});

// ---------------------------------------------------------------- the quiet rule (C1 born before the decision) and C1 provenance

test('classifyUse (quiet rule): a C1 use born before the decision is RESTART only with a quiet proof for exactly this decision and no prior sign', () => {
  const t = iso(T0_MS + 10 * 60_000);
  const c1 = (o = {}) => ({ t, pid: 5, birth: born(T0_MS) - 30, check: 'C1', quiet: { decision: T0, verdict: 'quiet' }, ...o });
  assert.equal(classifyUse(rec0, c1()), 'RESTART');
  assert.equal(classifyUse(rec0, c1({ priorSign: false })), 'RESTART');
  assert.equal(classifyUse(rec0, c1({ quiet: { decision: iso(T0_MS - HOUR), verdict: 'quiet' } })), 'MISS', 'a proof for another decision proves nothing here');
  assert.equal(classifyUse(rec0, c1({ quiet: { decision: T0, verdict: 'active' } })), 'MISS');
  assert.equal(classifyUse(rec0, c1({ quiet: { decision: T0, verdict: 'unknown' } })), 'MISS');
  assert.equal(classifyUse(rec0, c1({ quiet: 'quiet' })), 'MISS', 'quiet must be an object');
  assert.equal(classifyUse(rec0, c1({ quiet: undefined })), 'MISS');
  assert.equal(classifyUse(rec0, c1({ priorSign: true })), 'MISS', 'a prior sign beats the proof');
  for (const check of ['C2', 'C3', 'connection', undefined]) assert.equal(classifyUse(rec0, c1({ check })), 'MISS', `${check} never changes`);
  assert.equal(classifyUse(rec0, c1({ birth: null })), 'UNKNOWN', 'no identity stays UNKNOWN');
  assert.equal(classifyUse(rec0, c1({ t: iso(T0_MS + 3 * HOUR) })), null, 'outside the window it is not an outcome');
  assert.equal(classifyUse(rec0, c1({ birth: born(T0_MS) + 5 })), 'RESTART', 'born after is a RESTART as ever');
});

// The live shape, 2026-10-20: one container generation, two session-end would-stops, two sessions that leased the stack just
// after each, and the legacy worker probe records written at +30 min by the installed code.
const L_GEN = { id: '21ae0000-0000-4000-8000-000000000279', startedAt: '2026-10-20T02:51:51.546261985Z' };
const L_NOW = Date.parse('2026-10-20T06:00:00Z');
const L_P = 'autostop-live';
const lStop = (t) => ({ t, source: 'session-end', project: L_P, generation: L_GEN, mode: 'report', action: 'would-stop', reasons: ['r'] });
const sStop = (t) => ({ ...lStop(t), source: 'sweep' }); // a sweep-sourced would-stop has no observer: its CLEAN / RESTART rules are unchanged
const lObs = (t, decidedAt) => ({ t, source: 'session-end', project: L_P, generation: L_GEN, action: 'observed', reasons: ['r'], decidedAt });
const S1 = '2026-10-20T03:14:13.119Z';
const S2 = '2026-10-20T03:16:22.749Z';
const LIVE_DECS = [lStop(S1), lStop(S2), lObs('2026-10-20T05:14:13.119Z', S1), lObs('2026-10-20T05:16:22.749Z', S2)];
const S_A = 'e51acd5e-a3c0-4e8d-81ac-b36d727d3abe';
const S_B = '2f3b1ba8-1923-483d-a19d-75cb8b15a778';
const lease = (t, pid, birth, sessionId, o = {}) => ({ t, project: L_P, pid, birth, check: 'C1', command: 'lease via Bash', sessionId, ledger: true, ...o });
const liveLedger = () => [
  lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A), lease('2026-10-20T03:15:36.847Z', 9705, 1792466041, S_A),
  lease('2026-10-20T03:17:06.895Z', 72631, 1792466180, S_B), lease('2026-10-20T03:18:16.289Z', 72631, 1792466180, S_B),
];
const legacy = (t, pid, birth) => ({ t, project: L_P, pid, birth, check: 'C1', command: 'lease via Bash' });
const liveLegacy = () => [legacy('2026-10-20T03:44:13.000Z', 9705, 1792466041), legacy('2026-10-20T03:46:22.000Z', 72631, 1792466180)];
const COVER = { ok: true, repaired: false, firstT: '2026-10-20T01:00:00.000Z' };
const withQuiet = (uses, targets) => uses.map((u) => ({ ...u, quiet: { decision: targets[u.pid === 9705 ? 0 : 1], verdict: 'quiet' } }));

test('outcomeSummary (live shape): with quiet proofs and a complete ledger the two false MISSes are ONE RESTART row', () => {
  const uses = [...withQuiet(liveLedger(), [S1, S2]), ...liveLegacy()];
  const s = outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: COVER });
  assert.deepEqual([s.miss, s.unknown, s.restart, s.rows.length], [0, 0, 1, 1]);
  assert.equal(s.rows[0].outcome, 'RESTART');
  assert.equal(s.rows[0].uses.length, 4, 'the legacy duplicates are gone');
  assert.ok(s.rows[0].uses.every((u) => u.class === 'RESTART' && /born before the would-stop, first use after it \(transcript quiet\)/.test(u.why)));
});

test('outcomeSummary (live shape): without the proofs it is MISS, exactly as before', () => {
  const s = outcomeSummary(LIVE_DECS, [...liveLedger(), ...liveLegacy()], L_NOW, { ledgerCoverage: COVER });
  assert.deepEqual([s.miss, s.restart, s.rows.length], [1, 0, 1]);
  const none = outcomeSummary(LIVE_DECS, [...liveLedger(), ...liveLegacy()], L_NOW);
  assert.equal(none.miss, 1);
  assert.equal(none.rows[0].uses.length, 6, 'no coverage given: the legacy observations stay');
});

test('outcomeSummary (live shape): a proof for the other decision does not help', () => {
  const uses = withQuiet(liveLedger(), [S2, S1]); // swapped
  const s = outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: COVER });
  assert.equal(s.miss, 1);
});

test('outcomeSummary (live shape): a repaired ledger keeps the legacy 9705 observation, which has a prior sign => MISS', () => {
  const uses = [...withQuiet(liveLedger(), [S1, S2]), ...withQuiet(liveLegacy(), [S2, S2])];
  const s = outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: { ...COVER, repaired: true } });
  assert.equal(s.miss, 1);
  const kept = s.rows[0].uses.filter((u) => u.class === 'MISS');
  assert.deepEqual(kept.map((u) => [u.pid, u.against]), [[9705, S2]], 'charged to the later would-stop, with its earlier leases as the prior sign');
});

test('outcomeSummary (live shape): a ledger that began after the first would-stop, or an unread one, keeps the legacy observations => MISS', () => {
  const uses = [...withQuiet(liveLedger(), [S1, S2]), ...withQuiet(liveLegacy(), [S2, S2])];
  assert.equal(outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: { ...COVER, firstT: '2026-10-20T03:14:30.000Z' } }).miss, 1);
  assert.equal(outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: { ...COVER, ok: false } }).miss, 1);
  assert.equal(outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: { ok: true, repaired: false, firstT: null } }).miss, 1);
  assert.equal(outcomeSummary(LIVE_DECS, uses, L_NOW, { ledgerCoverage: undefined }).miss, 1);
});

test('outcomeSummary (live shape): a legacy observation is dropped only when a ledger lease of the same owner lies after the stop record, up to it', () => {
  const legacyOnly = liveLegacy();
  // no ledger use at all: the ledger snapshot was read before the lease arrived, so the observation stays
  const none = outcomeSummary(LIVE_DECS, legacyOnly, L_NOW, { ledgerCoverage: COVER });
  assert.equal(none.miss, 1, 'no ledger lease => the observation is the only sign of the lease');
  assert.equal(none.rows[0].uses.length, 2);
  // a matching ledger lease in the window: dropped
  const withLease = outcomeSummary(LIVE_DECS, [...liveLedger(), ...liveLegacy()], L_NOW, { ledgerCoverage: COVER });
  assert.equal(withLease.rows[0].uses.length, 4);
  // a ledger lease of the same owner only BEFORE the earliest stop record: the observation stays
  const before = [lease('2026-10-20T03:10:00.000Z', 9705, 1792466041, S_A)];
  const kept = outcomeSummary(LIVE_DECS, [...before, legacy('2026-10-20T03:44:13.000Z', 9705, 1792466041)], L_NOW, { ledgerCoverage: COVER });
  assert.ok(kept.rows[0].uses.some((u) => !u.ledger && u.pid === 9705), 'the observation stays');
  // a ledger lease of ANOTHER owner (pid or birth), or another project, does not vouch for it
  for (const other of [lease('2026-10-20T03:14:48.267Z', 9706, 1792466041, S_A), lease('2026-10-20T03:14:48.267Z', 9705, 1792466042, S_A), lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A, { project: 'other' })]) {
    const s = outcomeSummary(LIVE_DECS, [other, legacy('2026-10-20T03:44:13.000Z', 9705, 1792466041)], L_NOW, { ledgerCoverage: COVER });
    assert.ok(s.rows[0].uses.some((u) => !u.ledger && u.pid === 9705), 'the observation stays');
  }
  // a ledger lease AFTER the observation does not vouch for it either
  const after = outcomeSummary(LIVE_DECS, [lease('2026-10-20T03:50:00.000Z', 9705, 1792466041, S_A), legacy('2026-10-20T03:44:13.000Z', 9705, 1792466041)], L_NOW, { ledgerCoverage: COVER });
  assert.ok(after.rows[0].uses.some((u) => !u.ledger && u.pid === 9705), 'the observation stays');
});

test('outcomeSummary: a legacy observation with no session-end would-stop of its project in the 2 h 10 min before it stays', () => {
  const far = legacy('2026-10-20T05:50:00.000Z', 9705, 1792466041); // > 2 h 10 min after S2, inside no window of its own
  const s = outcomeSummary(LIVE_DECS, [far], L_NOW, { ledgerCoverage: COVER });
  assert.equal(s.rows[0].uses.length, 0, 'out of every window: not an outcome (and not dropped for a wrong reason)');
  const sweepStop = [{ ...lStop(S1), source: 'sweep' }, lObs('2026-10-20T05:14:13.119Z', S1)];
  const near = legacy('2026-10-20T03:44:13.000Z', 9705, 1792466041);
  const s2 = outcomeSummary(sweepStop, [near], L_NOW, { ledgerCoverage: COVER });
  assert.equal(s2.miss, 1, 'only session-end stop records show the worker ran');
});

test('outcomeSummary (prior sign): an earlier lease by the same pid and birth, even before the decision, keeps the use a MISS', () => {
  const early = lease('2026-10-20T03:10:00.000Z', 9705, 1792466041, S_A);
  const first = lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A, { quiet: { decision: S1, verdict: 'quiet' } });
  assert.equal(outcomeSummary([sStop(S1)], [early, first], L_NOW).miss, 1);
  const other = outcomeSummary([sStop(S1)], [first], L_NOW);
  assert.equal(other.restart, 1, 'the same use alone is a RESTART');
});

test('outcomeSummary (prior sign): the same pid with another birth (pid reuse) is not a prior sign', () => {
  const reused = lease('2026-10-20T03:10:00.000Z', 9705, 1700000000, 'old-session');
  const first = lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A, { quiet: { decision: S1, verdict: 'quiet' } });
  const s = outcomeSummary([sStop(S1)], [reused, first], L_NOW);
  assert.equal(s.rows[0].uses.find((u) => u.sessionId === S_A).class, 'RESTART');
});

test('outcomeSummary (prior sign): an earlier C2 observation of the same owner is a prior sign, whatever its source', () => {
  const c2 = { t: '2026-10-20T03:13:00.000Z', project: L_P.toUpperCase(), pid: 9705, birth: 1792466041, check: 'C2' };
  const first = lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A, { quiet: { decision: S1, verdict: 'quiet' } });
  assert.equal(outcomeSummary([sStop(S1)], [c2, first], L_NOW).miss, 1);
  const later = { ...c2, t: '2026-10-20T03:14:20.000Z' }; // after the decision: not a prior sign
  assert.equal(outcomeSummary([sStop(S1)], [later, first], L_NOW).rows[0].uses.find((u) => u.check === 'C1').class, 'RESTART');
});

test('outcomeSummary: a C1 duplicate (ledger lease + worker observation of the same lease) is counted once, preferring the ledger one', () => {
  const led = lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A);
  const obs = { ...led, ledger: undefined, seenAt: '2026-10-20T03:44:13.000Z', command: 'lease via Bash' };
  delete obs.ledger;
  for (const order of [[led, obs], [obs, led]]) {
    const s = outcomeSummary([sStop(S1)], order, L_NOW);
    assert.equal(s.rows[0].uses.length, 1);
    assert.equal(s.rows[0].uses[0].ledger, true);
  }
  // the duplicate must not make the lease its own prior sign
  const withQ = { ...led, quiet: { decision: S1, verdict: 'quiet' } };
  assert.equal(outcomeSummary([sStop(S1)], [withQ, obs], L_NOW).restart, 1);
});

test('quietCandidates: the C1 uses that are MISS only for want of a proof; none that have a prior sign, a quiet proof, no session or no identity', () => {
  const c = quietCandidates(LIVE_DECS, [...liveLedger(), ...liveLegacy()], { ledgerCoverage: COVER });
  assert.deepEqual(c.map((x) => [x.use.pid, x.use.t, x.decision.t]), [
    [9705, '2026-10-20T03:14:48.267Z', S1], [9705, '2026-10-20T03:15:36.847Z', S1],
    [72631, '2026-10-20T03:17:06.895Z', S2], [72631, '2026-10-20T03:18:16.289Z', S2],
  ]);
  assert.deepEqual([...new Set(c.map((x) => `${x.use.pid}|${x.decision.t}`))], [`9705|${S1}`, `72631|${S2}`], 'two (owner, decision) pairs need a transcript');
  // a repaired ledger keeps the legacy 9705 observation (prior sign) => it is not a candidate
  const kept = quietCandidates(LIVE_DECS, [...liveLedger(), ...liveLegacy()], { ledgerCoverage: { ...COVER, repaired: true } });
  assert.ok(!kept.some((x) => !x.use.ledger && x.use.pid === 9705), 'a use with a prior sign needs no proof');
  assert.ok(kept.some((x) => !x.use.ledger && x.use.pid === 72631) === false, 'legacy 72631 has no session id');
  const early = lease('2026-10-20T03:10:00.000Z', 9705, 1792466041, S_A);
  assert.deepEqual(quietCandidates(LIVE_DECS, [early, ...liveLedger()], {}).map((x) => x.use.pid), [72631, 72631], 'the 9705 uses have a prior sign');
  assert.deepEqual(quietCandidates(LIVE_DECS, withQuiet(liveLedger(), [S1, S2]), {}), [], 'proofs already attached');
  assert.deepEqual(quietCandidates(LIVE_DECS, [lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, null)], {}), [], 'no session id');
  assert.deepEqual(quietCandidates(LIVE_DECS, [lease('2026-10-20T03:14:48.267Z', 9705, null, S_A)], {}), [], 'no identity');
  assert.deepEqual(quietCandidates(LIVE_DECS, [lease('2026-10-20T03:14:48.267Z', 9705, 1792466041 + 100, S_A)], {}), [], 'born after: a RESTART already');
  assert.deepEqual(quietCandidates(LIVE_DECS, [{ ...lease('2026-10-20T03:14:48.267Z', 9705, 1792466041, S_A), check: 'C2' }], {}), [], 'C2 never');
  assert.deepEqual(quietCandidates(LIVE_DECS, [lease('2026-10-20T08:00:00.000Z', 9705, 1792466041, S_A)], {}), [], 'outside the window');
});

test('renderReport / renderWeekly pass ledgerCoverage to the summary; a RESTART by the quiet rule says why', () => {
  const uses = [...withQuiet(liveLedger(), [S1, S2]), ...liveLegacy()];
  const state = { now: L_NOW, decisions: LIVE_DECS, uses, ledgerCoverage: COVER };
  const r = renderReport(state);
  assert.match(r, /MISS 0 \(must be 0 to switch on\)/);
  assert.match(r, /RESTART 1/);
  assert.match(r, /born before the would-stop, first use after it \(transcript quiet\)/);
  assert.match(renderWeekly(state), /MISS 0 \(must be 0 to switch on\); RESTART 1/);
  assert.match(renderReport({ ...state, ledgerCoverage: undefined }), /MISS 1/);
});

test('renderReport: one generation with two would-stop decisions and several RESTART uses is 1 stack run in the headline and ONE group in the section', () => {
  const uses = [...withQuiet(liveLedger(), [S1, S2]), ...liveLegacy()];
  const state = { now: L_NOW, decisions: LIVE_DECS, uses, ledgerCoverage: COVER };
  const s = outcomeSummary(state.decisions, state.uses, L_NOW, { ledgerCoverage: COVER });
  assert.deepEqual([s.restart, s.rows.length, s.rows[0].decisions, s.rows[0].uses.length], [1, 1, 2, 4], 'classification is unchanged: one RESTART row');
  const text = renderReport(state);
  assert.match(text, /^- RESTART 1 stack run \(2 would-stop decisions; cost only/m);
  assert.match(text, /^- CLEAN 0/m);
  const section = text.split('## RESTART')[1].split(/\n## /)[0].split('\n').filter(Boolean).slice(1);
  const heads = section.filter((l) => l.startsWith('- '));
  assert.equal(heads.length, 1, 'one heading for the one stack run');
  assert.match(heads[0], /RESTART: 2 would-stop decisions, 4 uses/);
  const nested = section.filter((l) => l.startsWith('  - '));
  assert.equal(nested.length, 4, 'every use is listed under the heading');
  assert.equal(new Set(nested.map((l) => /would-stop (\S+) /.exec(l)[1])).size, 2, 'the uses name both would-stop times');
  assert.ok(nested.some((l) => l.includes(S1)) && nested.some((l) => l.includes(S2)));
  // the switch-on line counts the same unit
  const clean = renderReport({ now: L_NOW, decisions: [lStop(S1), lStop(S2), lObs('2026-10-20T05:14:13.119Z', S1), lObs('2026-10-20T05:16:22.749Z', S2)], uses: [], ledgerCoverage: COVER });
  assert.match(clean, /no unknown across 1 stack run \(2 would-stop decisions\)/);
});
