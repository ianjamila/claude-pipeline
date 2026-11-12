// Per-round cost booking (follow-up to #279, plan 2026-11-12-round-cost-park-stats.md T1): `P cost --round R` books an entry into cost.byRound[R] as well,
// the shape check and the display lines know the section, and the extra-round ask names what the newest counted round cost. Display only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { addCostEntry, costLines, costReport, costShapeProblem, emptyCost } from '../pipeline/lib/run-cost.mjs';
import { askSummary, costFrom } from '../pipeline/lib/round-ask.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { decodeRecord, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { roundWorld } from './helpers/round-world.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';

const entry = (o = {}) => ({ phase: 'review', role: 'judge', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, usd: 0.25, ...o });
const totals = (usd, calls = 1) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd, calls });

test('addCostEntry: --round entries are summed per round next to the total; an entry without a round leaves byRound alone', () => {
  let c = addCostEntry(null, entry({ round: 1, usd: 1.5 }));
  c = addCostEntry(c, entry({ round: 1, role: 'implementer', usd: 0.5 }));
  c = addCostEntry(c, entry({ round: 2, usd: 3 }));
  c = addCostEntry(c, entry({ phase: 'build', usd: 0.1 })); // a build-phase call: no round
  assert.deepEqual(c.byRound['1'], { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, usd: 2, calls: 2 });
  assert.equal(c.byRound['2'].usd, 3);
  assert.equal(c.total.usd, 5.1);
  assert.equal(addCostEntry(null, entry()).byRound, undefined, 'old callers: no byRound key at all');
  assert.equal(emptyCost().byRound, undefined);
  assert.throws(() => addCostEntry(null, entry({ round: 0 })), /round/);
  assert.throws(() => addCostEntry(null, entry({ round: 1.5 })), /round/);
  assert.throws(() => addCostEntry(null, entry({ round: 'x' })), /round/);
});

test('costShapeProblem: byRound is optional, must be a plain object whose keys are positive integers', () => {
  const c = addCostEntry(null, entry({ round: 3 }));
  assert.equal(costShapeProblem(c), null);
  assert.equal(costShapeProblem(addCostEntry(null, entry())), null);
  assert.equal(costShapeProblem({ ...c, byRound: [] }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byRound: 'x' }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byRound: { x: totals(1) } }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byRound: { '0': totals(1) } }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byRound: { '1.5': totals(1) } }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byRound: { '2': 'x' } }), 'bad cost');
});

test('costReport / costLines: byRound is reported and shown as a "By round" row when present, absent otherwise', () => {
  const c = addCostEntry(addCostEntry(null, entry({ round: 1, usd: 1 })), entry({ round: 2, usd: 2 }));
  assert.deepEqual(Object.keys(costReport(c).byRound), ['1', '2']);
  assert.equal(costReport(c).byRound['2'].usd, 2);
  const row = costLines(c).find((l) => l.startsWith('- **By round:**'));
  assert.match(row, /round 1 \$1\.00 \(150 tok\) · round 2 \$2\.00 \(150 tok\)/);
  const old = addCostEntry(null, entry());
  assert.equal('byRound' in costReport(old), false);
  assert.ok(!costLines(old).some((l) => l.includes('By round')));
});

test('costFrom: lastRoundUsd is the cost booked to the newest COUNTED round with an entry; base-only rounds are skipped; none is null', () => {
  const state = { rounds: [{ n: 1 }, { n: 2 }, { n: 3, baseOnly: true }] };
  const record = (byRound) => ({ cost: { total: totals(10), byPhase: { review: totals(8) }, byRole: {}, byRound } });
  // round 3 is base-only: its booking is not a counted round's cost, so round 2 is the answer
  const c = costFrom(record({ '1': totals(1.234), '2': totals(2.345), '3': totals(9) }), 2, state);
  assert.deepEqual([c.lastRound, c.lastRoundUsd], [2, 2.35]);
  assert.deepEqual([c.bookedUsd, c.reviewUsd, c.perRoundUsd], [10, 8, 4]);
  // the newest counted round has no entry: fall back to the newest counted round that has one
  const d = costFrom(record({ '1': totals(1) }), 2, state);
  assert.deepEqual([d.lastRound, d.lastRoundUsd], [1, 1]);
  for (const r of [record(undefined), record({}), record({ '3': totals(1) })]) {
    const x = costFrom(r, 2, state);
    assert.deepEqual([x.lastRound, x.lastRoundUsd], [null, null]);
  }
  assert.deepEqual([costFrom(record({ '1': totals(1) }), 2).lastRound, costFrom(record({ '1': totals(1) }), 2).lastRoundUsd], [null, null], 'no state given: nothing to match against');
});

test('askSummary: names the last round\'s cost when known, keeps the per-round average as the fallback', () => {
  const base = { rounds: { reviewed: 2, max: 1, autoExtraUsed: true, ownerGranted: 0, next: 3 }, open: [], notClean: [], follow: { eligible: false, refusals: ['x'] }, discard: { count: 0 } };
  const known = askSummary({ ...base, cost: { bookedUsd: 20, reviewUsd: 12, fableUsd: 4, perRoundUsd: 6, lastRound: 2, lastRoundUsd: 7.5 } }).summary;
  assert.match(known, /Booked agent cost so far: \$20\.00, review \$12\.00 \(the last round \(2\) cost \$7\.50; about \$6\.00 per round\)\./);
  const avg = askSummary({ ...base, cost: { bookedUsd: 20, reviewUsd: 12, fableUsd: 4, perRoundUsd: 6, lastRound: null, lastRoundUsd: null } }).summary;
  assert.match(avg, /Booked agent cost so far: \$20\.00, review \$12\.00 \(about \$6\.00 per round\)\./);
  assert.doesNotMatch(avg, /the last round/);
});

// ---- the CLI -------------------------------------------------------------------------------------------------------

const PATCH_77 = { match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' } };
function existing(record) {
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record, sections: '' });
  return { id: 77, user: { login: 'me' }, body, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' };
}
const withComment = (s, comment) => s.fake.setScript(ghEntries({ prHead: s.head, comments: comment ? [comment] : [], extra: [PATCH_77, { match: '^pr view 12 --json title', stdoutJson: { title: 'T' } }] }));
const written = (s) => {
  const w = s.fake.calls().filter((c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3)));
  return decodeRecord(JSON.parse(w.at(-1).stdin).body).record;
};
const costCli = (s, args) => cli(['cost', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });

test('P cost --round R: the entry also lands in byRound[R] and adds up; without --round byRound does not appear', () => {
  const s = scenario();
  const r = costCli(s, ['--phase', 'review', '--role', 'judge', '--input', '10', '--usd', '1.5', '--round', '2']);
  assertExit(r, 0);
  assert.equal(r.json.cost.byRound['2'].usd, 1.5);
  assert.equal(r.json.cost.total.usd, 1.5);
  withComment(s, existing(written(s)));
  const r2 = costCli(s, ['--phase', 'review', '--role', 'implementer', '--usd', '0.5', '--round', '2']);
  assertExit(r2, 0);
  assert.deepEqual([r2.json.cost.byRound['2'].usd, r2.json.cost.byRound['2'].calls], [2, 2]);
  withComment(s, existing(written(s)));
  const r3 = costCli(s, ['--phase', 'build', '--role', 'implementer', '--usd', '0.25']);
  assertExit(r3, 0);
  assert.deepEqual(Object.keys(r3.json.cost.byRound), ['2']);
  assert.equal(r3.json.cost.total.usd, 2.25);
  const fresh = scenario();
  assert.equal(costCli(fresh, ['--phase', 'build', '--role', 'implementer', '--usd', '1']).json.cost.byRound, undefined);
});

test('P cost --round: a bad round, or a round with nothing to book, is a usage error (exit 2) and writes nothing', () => {
  const s = scenario();
  const before = s.fake.calls().length;
  for (const bad of ['0', '-1', '1.5', 'abc']) assertExit(costCli(s, ['--phase', 'review', '--role', 'judge', '--usd', '1', '--round', bad]), 2);
  assertExit(costCli(s, ['--phase', 'review', '--role', 'judge', '--retry', '--round', '1']), 2);
  assert.equal(s.fake.calls().length, before);
});

// ---- the ask, end to end ---------------------------------------------------------------------------------------------

test('round-request: with per-round bookings the summary names the last round\'s cost; the closing line is unchanged', (t) => {
  const cost = { total: totals(23.4, 40), byPhase: { review: totals(18.1, 20) }, byRole: { arbiter: totals(6.2, 5) }, byRound: { '1': totals(8), '2': totals(9.5) }, retries: 0, guardBlocks: null, sessions: [] };
  const body = `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', baseRef: 'main' }), cost })}`;
  const w = roundWorld(t, { comments: [{ id: 77, user: { login: 'me' }, body }] });
  const { h2 } = w.atCap();
  const r = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.cost.lastRound, r.json.cost.lastRoundUsd], [2, 9.5]);
  assert.match(r.json.summary, /Booked agent cost so far: \$23\.40, review \$18\.10 \(the last round \(2\) cost \$9\.50; about \$9\.05 per round\)\./);
  assert.equal(r.json.line, `🔁 Extra review round needed #7: round 3 · head ${h2.slice(0, 12)} · repo ${w.slug}`);
});
